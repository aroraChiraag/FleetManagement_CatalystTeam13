/*
 * Dispatch Copilot planning engine (isomorphic: Node server + browser fallback).
 *
 *   planDay(day)               -> 06:30 plan + live replay of every call-in pickup at its real dispatch time
 *   manualPlan(day)            -> what dispatch actually did, re-costed with the same model (baseline)
 *   detectConflicts(plan, day) -> safety / compliance / service / data-quality issues with fixes
 *   disrupt(plan, day, event)  -> ranked recovery options for breakdown, driver absence, hot order, failed delivery
 *
 * Every number the engine invents (capacity, speeds, costs, windows) lives in ASSUMPTIONS so the UI and API
 * can show it next to the recommendation it influenced.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CopilotEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ assumptions
  const VEHICLES = {
    STRAIGHT_26: { label: '26 ft straight truck', short: 'Straight 26′', maxLb: 10000, spots: 12, feet: 26, licence: ['DZ', 'AZ'], costKm: 0.95, tailgate: true, rows: 6 },
    TRACTOR_53: { label: 'Tractor + 53 ft trailer', short: 'Tractor 53′', maxLb: 48000, spots: 26, feet: 53, licence: ['AZ'], costKm: 1.35, tailgate: false, rows: 13 },
    CARGO_VAN: { label: 'Cargo van', short: 'Van', maxLb: 2500, spots: 2, feet: 10, licence: ['G', 'DZ', 'AZ'], costKm: 0.55, tailgate: false, rows: 1 },
  };

  const ASSUMPTIONS = {
    roadFactor: { value: 1.3, text: 'Road distance = straight-line distance × 1.3 (GTA circuity). Replace with Google Routes / Samsara distances in production.' },
    speeds: { value: '32 km/h first 15 km, 68 km/h after', text: 'Urban legs average 32 km/h, highway portion 68 km/h.' },
    serviceTime: { value: '15 min + extras', text: '15 min per stop (same as the Samsara set-up) + 4 min per skid over 2, +15 inside delivery / helpers, +10 tailgate, +10 residential, capped at 75 min.' },
    shift: { value: '06:30 on duty, 07:00 departure', text: '30 min loading/pre-trip before departure, 15 min post-trip after return. Routes may depart as early as 05:00 for early appointments.' },
    hos: { value: '13 h driving / 14 h on duty', text: 'Canadian federal Commercial Vehicle Drivers Hours of Service (south of 60°N) daily limits.' },
    capacity: { value: 'Straight 10,000 lb / 12 spots · 53′ 48,000 lb / 26 spots · Van 2,500 lb / 2 spots', text: 'Vehicle class inferred from unit name (Truck # / Tractor # / plate-only). Payloads are typical values, not unit-specific specs.' },
    licence: { value: 'AZ if ever seen in a tractor, else DZ', text: 'Driver licence class inferred from the vehicles each driver drove in the 2-week export.' },
    release: { value: 'Pickups released at dispatch time; terminal freight at 06:30', text: 'Freight to deliver is assumed in the Scarborough terminal at 06:30. Pickups become known when Elite dispatched them (real timestamps).' },
    promises: { value: 'LTL/Overnight by 17:00 · Rush +4 h · Rush90 +90 min · After-hours 17:00–23:00', text: 'Service promises per Elite service level. Appointments: arrive between appt −30 min and appt +15 min (hard).' },
    costs: { value: '$34/h driver (8 h minimum when used), $/km by class', text: 'Straight $0.95/km, 53′ $1.35/km, van $0.55/km. The optimiser weighs each minute late against a service promise at $8 (planning weight, not a real cost) and avoids plans more than 30 min past a promise whenever any feasible alternative exists.' },
    partner: { value: 'LTL $125 + (weight/100) × ($9 + $0.045/km) · FTL $350 + $3/km', text: 'Indicative partner-carrier quotes (LTL by weight and distance, FTL over 10,000 lb by distance). Used for out-of-province freight and when the in-house marginal cost is higher.' },
    stacking: { value: 'Skids floor-loaded, loose freight may share a spot', text: 'Skids/pallets are not stacked (no stackability data in Elite); loose pieces < 1 spot share a spot; dangerous goods never stacked.' },
    co2: { value: '0.95 kg CO₂e per truck-km', text: 'Diesel medium/heavy truck average; indicative only.' },
  };

  const DEPOT_DEFAULT = { lat: 43.80800808529279, lng: -79.24190011829823 };
  const WAGE = 34, REAL_MIN_SHIFT = 480, PRETRIP = 30, POSTTRIP = 15, RELOAD = 20;
  const EARLIEST_DEPART = 300, DAY_START = 390;
  const DRIVE_MAX = 780;

  // ------------------------------------------------------------------ plan settings (custom plans)
  const OBJECTIVES = {
    cost: { label: 'Lowest total cost', text: 'Each driver called in costs at least an 8 h shift, so freight is packed onto the vehicle type that fits it before another unit is started. This is the default copilot plan.', minShift: 480, latePenalty: 10, kmWeight: 1, balance: 0 },
    service: { label: 'Best service', text: 'Lateness weighs three times as much and a truck costs half as much to start, so the planner adds a truck rather than run late.', minShift: 240, latePenalty: 30, kmWeight: 1, balance: 0 },
    balanced: { label: 'Use the whole fleet', text: 'Starting a truck is free and long shifts are penalised, so work is spread across every available driver and vehicle type.', minShift: 0, latePenalty: 10, kmWeight: 1, balance: 0.1 },
    distance: { label: 'Fewest kilometres', text: 'Distance weighs three times as much: the lowest fuel and emissions, even if it uses a few more driver hours.', minShift: 240, latePenalty: 10, kmWeight: 3, balance: 0 },
  };
  const DEFAULT_SETTINGS = { objective: 'cost', departTime: 420, maxDutyHours: 14, serviceMin: 15, allowPartner: true, allowReloads: true, liveReplay: true, drivers: null };
  function makeCfg(settings) {
    const st = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    st.objective = OBJECTIVES[st.objective] ? st.objective : 'cost';
    const o = OBJECTIVES[st.objective];
    st.maxDutyHours = Math.max(6, Math.min(14, Number(st.maxDutyHours) || 14));
    st.departTime = Math.max(300, Math.min(600, Number(st.departTime) || 420));
    st.serviceMin = Math.max(5, Math.min(40, Number(st.serviceMin) || 15));
    return {
      settings: st, objective: st.objective,
      depart: st.departTime, dutyMax: st.maxDutyHours * 60, serviceBase: st.serviceMin,
      allowPartner: st.allowPartner !== false, allowReloads: st.allowReloads !== false,
      minShift: o.minShift, latePenalty: o.latePenalty, kmWeight: o.kmWeight, balance: o.balance, promiseSlack: 0,
    };
  }
  let C = makeCfg();
  const RUSH = ['RUSH', 'SAME DAY', 'RUSH90', 'EXPEDITE', 'EXCLUSIVE', 'NONSTOP'];

  // ------------------------------------------------------------------ geometry
  function haversine(a, b) {
    const R = 6371, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  const roadKm = (a, b) => haversine(a, b) * ASSUMPTIONS.roadFactor.value;
  const travelMin = (d) => (d <= 15 ? (d / 32) * 60 : (15 / 32) * 60 + ((d - 15) / 68) * 60);
  const hhmm = (m) => {
    if (m == null || isNaN(m)) return '—';
    const d = Math.floor(m / 1440), r = ((Math.round(m) % 1440) + 1440) % 1440;
    return `${String(Math.floor(r / 60)).padStart(2, '0')}:${String(r % 60).padStart(2, '0')}${d > 0 ? ' +1d' : ''}`;
  };
  const r1 = (x) => Math.round(x * 10) / 10;

  function partnerQuote(t, depot) {
    const d = roadKm(depot, t);
    if (t.weight > 10000) return Math.round(350 + 3 * d);
    return Math.round(125 + (Math.max(t.weight, 100) / 100) * (9 + 0.045 * d));
  }

  // ------------------------------------------------------------------ problem set-up
  function prepTask(raw, depot) {
    const t = Object.assign({}, raw);
    const svc = new Set(t.service || []);
    const handling = new Set(t.handling || []);
    const equip = new Set(t.equipment || []);
    t.isPickup = t.kind !== 'D';
    t.issues = [];
    if (t.weight > VEHICLES.TRACTOR_53.maxLb) {
      // a full truckload heavier than the assumed payload: plan it as one dedicated trailer, flag the weight
      t.issues.push('weight_over_payload');
      t.declaredWeight = t.weight;
      const f = VEHICLES.TRACTOR_53.maxLb / t.weight;
      t.weight = VEHICLES.TRACTOR_53.maxLb; t.pickW = Math.round((t.pickW || 0) * f); t.dropW = Math.round((t.dropW || 0) * f);
    }
    t.rush = RUSH.some((x) => svc.has(x));
    t.rush90 = svc.has('RUSH90');
    t.afterHours = svc.has('AFTER HOURS');
    t.dg = handling.has('dangerous goods');
    t.depotKm = r1(roadKm(depot, t));
    t.release = t.isPickup && t.dispatchedAt != null && t.dispatchedAt > DAY_START ? t.dispatchedAt : DAY_START;

    let svcMin = C.serviceBase + Math.max(0, (t.spots || 0) - 2) * 4;
    if (handling.has('inside delivery') || [...handling].some((h) => h.startsWith('helpers'))) svcMin += 15;
    if (handling.has('tailgate')) svcMin += 10;
    if (handling.has('residential')) svcMin += 10;
    t.serviceMin = Math.min(75, svcMin);

    // terminal freight is loaded the night before: a delivery can start as soon as the truck gets there
    t.earliest = t.isPickup ? t.release : 0;
    if (t.afterHours) t.earliest = Math.max(t.earliest, 17 * 60);
    t.hardLatest = null;
    const apptValid = t.appt != null && t.appt >= 300 && t.appt <= 23 * 60;
    if (t.appt != null && !apptValid) t.issues.push('appointment_invalid');
    if (apptValid) {
      t.earliest = Math.max(t.earliest, t.appt - 30);
      t.hardLatest = t.appt + 15;
      t.latest = t.appt + 15;
    } else if (t.rush) t.latest = t.release + (t.rush90 ? 90 : 240);
    else if (t.afterHours) t.latest = 23 * 60;
    else if (t.isPickup) t.latest = Math.max(17 * 60, t.release + 180);
    else t.latest = svc.has('OUT OF TOWN') ? 19 * 60 : 17 * 60;

    const needsTractor = equip.has('53FT TRAILER') || equip.has('TRACTOR') || svc.has('FTL') || svc.has('FULL LOAD') || svc.has('FLAT BED') || t.spots > 12 || t.weight > 10000;
    const noTractor = handling.has('tailgate') || handling.has('residential');
    const vanOk = !t.dg && !needsTractor && t.weight <= 2500 && t.spots <= 2 && !handling.has('tailgate');
    t.allowed = needsTractor ? ['TRACTOR_53'] : ['STRAIGHT_26'].concat(noTractor ? [] : ['TRACTOR_53'], vanOk ? ['CARGO_VAN'] : []);
    if (needsTractor && noTractor) t.issues.push('equipment_conflict');
    t.partnerOnly = !['ON', 'QC'].includes(t.prov || 'ON');
    return t;
  }

  function buildProblem(day, depot, cfg) {
    depot = depot || DEPOT_DEFAULT;
    if (cfg) C = cfg;
    const tasks = {};
    day.tasks.forEach((raw) => (tasks[raw.id] = prepTask(raw, depot)));
    const inUnit = new Set();
    const units = [];
    const pairOf = {};
    for (const [p, d, ordno] of day.pairs || []) {
      if (inUnit.has(p) || inUnit.has(d) || !tasks[p] || !tasks[d]) continue;
      inUnit.add(p); inUnit.add(d);
      pairOf[d] = p;
      const P = tasks[p], D = tasks[d];
      D.pairedWith = p; P.pairedWith = d; P.ordno = ordno;
      D.earliest = Math.max(D.earliest, P.release);
      if (D.hardLatest == null && D.rush) D.latest = P.release + (D.rush90 ? 90 : 240);
      else if (D.hardLatest == null) D.latest = Math.max(D.latest, P.release + 240);
      units.push({ id: 'U' + p, tasks: [p, d], release: P.release });
    }
    for (const id of Object.keys(tasks)) {
      if (!inUnit.has(id)) units.push({ id: 'U' + id, tasks: [id], release: tasks[id].release });
    }
    for (const u of units) {
      u.allowed = u.tasks.map((id) => tasks[id].allowed).reduce((a, b) => a.filter((x) => b.includes(x)));
      u.partnerOnly = u.tasks.some((id) => tasks[id].partnerOnly);
      u.weight = u.tasks.reduce((s, id) => s + tasks[id].weight, 0);
    }
    return { cfg: C, depot, tasks, units, unitOf: Object.fromEntries(units.flatMap((u) => u.tasks.map((t) => [t, u]))) };
  }

  function makeRoute(res, idx, startTime) {
    return {
      id: 'R' + String(idx + 1).padStart(2, '0'),
      driver: res.code, driverName: res.name, vehicle: res.vehicle || 'Unassigned unit',
      cls: res.vehicleClass || 'STRAIGHT_26', licence: res.licence || 'DZ',
      vehicleUnknown: !res.vehicle,
      done: [], seq: [],
      state: { lat: null, lng: null, time: startTime == null ? C.depart : startTime, drive: 0, km: 0, loadW: 0, loadS: 0, atDepot: true, dutyStart: null, started: false },
      insertedLive: {},
      init: { lat: null, lng: null, time: startTime == null ? C.depart : startTime, drive: 0, km: 0, loadW: 0, loadS: 0, atDepot: true, dutyStart: null, started: false },
    };
  }

  /** Rebuilds a frozen route as one full-day sequence from its initial state. */
  function unfreeze(P, route) {
    const items = route.done.map((d) => d.item).concat(route.seq);
    route.seq = items.filter((x, i) => typeof x === 'string' || (i < items.length - 1 && typeof items[i + 1] === 'string'));
    const dutyStart = route.state.dutyStart;
    route.done = [];
    route.state = JSON.parse(JSON.stringify(route.init));
    if (dutyStart != null && dutyStart + PRETRIP > C.depart) route.state.time = dutyStart + PRETRIP;
    evalRoute(P, route);
    return route;
  }

  // ------------------------------------------------------------------ route simulation
  function terminalDrop(P, id, route, seqSet) {
    const t = P.tasks[id];
    if (!t || t.dropW <= 0 && t.kind !== 'D') return null;
    if (t.pairedWith && (seqSet.has(t.pairedWith) || route.done.some((s) => s.id === t.pairedWith))) return null;
    return t;
  }

  /** Simulates `seq` on `route` from its current state. Returns schedule, KPIs and violations. */
  function simulate(P, route, seq, opts) {
    opts = opts || {};
    const v = VEHICLES[route.cls];
    const st = route.state;
    const depot = P.depot;
    const viol = [];
    const seqSet = new Set(seq.filter((x) => typeof x === 'string'));
    let pos = st.atDepot ? depot : { lat: st.lat, lng: st.lng };
    let time = st.time, drive = st.drive, km = st.km, loadW = st.loadW, loadS = st.loadS;
    let dutyStart = st.dutyStart;
    let late = 0, wait = 0, maxW = Math.max(loadW, st.maxW || 0), maxS = Math.max(loadS, st.maxS || 0);
    const stops = [];

    const segmentLoad = (from) => {
      let w = 0, s = 0;
      for (let i = from; i < seq.length && typeof seq[i] === 'string'; i++) {
        const t = terminalDrop(P, seq[i], route, seqSet);
        if (t) { w += t.kind === 'M' ? t.dropW : t.dropW || t.weight; s += t.kind === 'M' ? t.dropSp : t.dropSp || t.spots; }
      }
      return { w, s };
    };

    if (seq.length && st.atDepot) {
      const l = segmentLoad(0);
      loadW += l.w; loadS += l.s;
      if (!st.started) {
        // depart at 07:00, or earlier (not before 05:00) when the first stop has an early hard window
        const first = typeof seq[0] === 'string' ? P.tasks[seq[0]] : null;
        let dep = Math.max(time, C.depart);
        if (first && first.hardLatest != null) {
          const need = first.hardLatest - travelMin(roadKm(depot, first)) - 10;
          if (need < dep) dep = Math.max(EARLIEST_DEPART, need, st.time === C.depart ? EARLIEST_DEPART : st.time);
        }
        time = dep;
        dutyStart = dep - PRETRIP;
      }
    } else if (seq.length) {
      // mid-route: any terminal freight before the next terminal visit is not on the truck
      const onboard = new Set(st.onboard || []);
      for (let i = 0; i < seq.length && typeof seq[i] === 'string'; i++) {
        if (terminalDrop(P, seq[i], route, seqSet) && !onboard.has(seq[i])) { viol.push({ type: 'freight_not_on_truck', task: seq[i], hard: true }); break; }
      }
    }
    if (dutyStart == null) dutyStart = time - PRETRIP;
    maxW = Math.max(maxW, loadW); maxS = Math.max(maxS, loadS);
    const startW = loadW, startS = loadS;
    const seen = new Set(route.done.map((s) => s.id));

    for (let i = 0; i < seq.length; i++) {
      const item = seq[i];
      if (typeof item !== 'string') {
        if (!seq.slice(i + 1).some((x) => typeof x === 'string')) continue; // trailing terminal visit: nothing to reload
        const d = roadKm(pos, depot), tt = travelMin(d);
        const arr = time + tt;
        time = Math.max(arr, item.at || 0) + RELOAD;
        drive += tt; km += d; pos = depot;
        const l = segmentLoad(i + 1);
        loadW = l.w; loadS = l.s;
        maxW = Math.max(maxW, loadW); maxS = Math.max(maxS, loadS);
        stops.push({ depot: true, arr: Math.round(arr), dep: Math.round(time), loadW: Math.round(loadW), loadS: r1(loadS), legKm: r1(d) });
        continue;
      }
      const t = P.tasks[item];
      const d = roadKm(pos, t), tt = travelMin(d);
      time += tt; drive += tt; km += d;
      const arr = time;
      if (time < t.earliest) { wait += t.earliest - time; time = t.earliest; }
      const start = time;
      if (t.hardLatest != null && start > t.hardLatest + 0.5 && !opts.softAppointments) viol.push({ type: 'appointment', task: item, hard: true, by: Math.round(start - t.hardLatest) });
      const lateBy = Math.max(0, start - t.latest);
      late += lateBy;
      if (opts.strictPromises && lateBy > C.promiseSlack) viol.push({ type: 'promise', task: item, hard: true, by: Math.round(lateBy) });
      if (!t.allowed.includes(route.cls)) viol.push({ type: 'equipment', task: item, hard: true });
      if (t.pairedWith && t.kind === 'D' && !seen.has(t.pairedWith) && seqSet.has(t.pairedWith)) viol.push({ type: 'precedence', task: item, hard: true });
      time += t.serviceMin;
      loadW += (t.pickW || 0) - (t.kind === 'P' ? 0 : t.dropW || (t.kind === 'D' ? t.weight : 0));
      loadS += (t.pickSp || 0) - (t.kind === 'P' ? 0 : t.dropSp || (t.kind === 'D' ? t.spots : 0));
      loadW = Math.max(0, loadW); loadS = Math.max(0, loadS);
      maxW = Math.max(maxW, loadW); maxS = Math.max(maxS, loadS);
      seen.add(item);
      stops.push({ id: item, arr: Math.round(arr), start: Math.round(start), dep: Math.round(time), wait: Math.round(start - arr), late: Math.round(lateBy), loadW: Math.round(loadW), loadS: r1(loadS), legKm: r1(d) });
      pos = t;
    }
    let end = time;
    if (seq.length || !st.atDepot) {
      const d = roadKm(pos, depot), tt = travelMin(d);
      end = time + tt; drive += tt; km += d;
    }
    const used = seq.length > 0 || route.done.length > 0;
    const onDuty = used ? end + POSTTRIP - dutyStart : 0;
    if (maxW > v.maxLb + 0.5) viol.push({ type: 'overweight', hard: true, by: Math.round(maxW - v.maxLb) });
    if (maxS > v.spots + 0.01) viol.push({ type: 'overspots', hard: true, by: r1(maxS - v.spots) });
    if (drive > DRIVE_MAX) viol.push({ type: 'hos_drive', hard: true, by: Math.round(drive - DRIVE_MAX) });
    if (onDuty > C.dutyMax) viol.push({ type: 'hos_duty', hard: true, by: Math.round(onDuty - C.dutyMax) });
    const cost = used ? km * v.costKm + (Math.max(onDuty, REAL_MIN_SHIFT) / 60) * WAGE : 0;
    const objCost = used ? km * v.costKm * C.kmWeight + (Math.max(onDuty, C.minShift) / 60) * WAGE + (C.balance * onDuty * onDuty) / 60 : 0;
    return {
      feasible: !viol.some((x) => x.hard), viol, stops,
      km: r1(km), drive: Math.round(drive), onDuty: Math.round(onDuty), dutyStart: Math.round(dutyStart), end: Math.round(end),
      late: Math.round(late), wait: Math.round(wait), maxW: Math.round(maxW), maxS: r1(maxS), startW, startS,
      cost: objCost + late * C.latePenalty, opCost: Math.round(cost),
    };
  }

  function evalRoute(P, route) {
    route.sim = simulate(P, route, route.seq, { softAppointments: route.softAppointments });
    return route.sim;
  }

  // ------------------------------------------------------------------ insertion
  function candidateSeqs(P, route, unit) {
    const seq = route.seq, n = seq.length, out = [];
    const firstOpen = route.lockedPrefix || 0;
    if (unit.tasks.length === 1) {
      const id = unit.tasks[0];
      const t = P.tasks[id];
      const needsTerminal = (t.kind === 'D' || (t.kind === 'M' && t.dropW > 0)) && !t.pairedWith;
      for (let i = firstOpen; i <= n; i++) {
        const markerBefore = route.state.atDepot || seq.slice(0, i).some((x) => typeof x !== 'string');
        if (!needsTerminal || markerBefore) out.push(seq.slice(0, i).concat([id], seq.slice(i)));
        if (needsTerminal && C.allowReloads && (!route.state.atDepot || n > 0)) out.push(seq.slice(0, i).concat([{ depot: true, at: unit.release }, id], seq.slice(i)));
      }
    } else {
      const [p, d] = unit.tasks;
      for (let i = firstOpen; i <= n; i++) {
        for (let j = i; j <= n; j++) {
          out.push(seq.slice(0, i).concat([p], seq.slice(i, j), [d], seq.slice(j)));
        }
      }
    }
    return out;
  }

  function bestInsertion(P, route, unit, opts) {
    if (!unit.allowed.includes(route.cls)) return null;
    opts = Object.assign({ softAppointments: route.softAppointments }, opts);
    const base = route.sim || evalRoute(P, route);
    let best = null;
    for (const s of candidateSeqs(P, route, unit)) {
      const sim = simulate(P, route, s, opts);
      if (!sim.feasible) continue;
      const delta = sim.cost - base.cost;
      if (!best || delta < best.delta) best = { delta, seq: s, sim };
    }
    return best;
  }

  function applyInsertion(P, route, ins) {
    route.seq = ins.seq;
    route.sim = ins.sim;
  }

  /** Regret-2 insertion of `units` into `routes`. Returns units that could not be placed. */
  function regretInsert(P, routes, units, opts) {
    const pending = new Map(units.map((u) => [u.id, u]));
    const cache = new Map();
    const calc = (u, r) => bestInsertion(P, r, u, Object.assign({ strictPromises: true }, opts)) || bestInsertion(P, r, u, opts);
    for (const u of units) cache.set(u.id, routes.map((r) => calc(u, r)));
    const failed = [];
    while (pending.size) {
      let pick = null, pickScore = -Infinity;
      for (const u of pending.values()) {
        const opts2 = cache.get(u.id).map((x, i) => (x ? { x, i } : null)).filter(Boolean).sort((a, b) => a.x.delta - b.x.delta);
        if (!opts2.length) { pick = { u, none: true }; break; }
        const regret = opts2.length > 1 ? opts2[1].x.delta - opts2[0].x.delta : 1e6;
        const score = regret + u.weight / 1000;
        if (score > pickScore) { pickScore = score; pick = { u, best: opts2[0] }; }
      }
      pending.delete(pick.u.id);
      if (pick.none) { failed.push(pick.u); continue; }
      const r = routes[pick.best.i];
      applyInsertion(P, r, pick.best.x);
      if (opts && opts.onInsert) opts.onInsert(pick.u, r, pick.best.x);
      for (const u of pending.values()) cache.get(u.id)[pick.best.i] = calc(u, r);
    }
    return failed;
  }

  function removeUnit(route, unit) {
    const ids = new Set(unit.tasks);
    let seq = route.seq.filter((x) => typeof x !== 'string' || !ids.has(x));
    // drop depot markers that no longer serve anything
    seq = seq.filter((x, i) => typeof x === 'string' || (i < seq.length - 1 && typeof seq[i + 1] === 'string'));
    return seq;
  }

  /** Relocate local search: move each unit to its cheapest feasible position anywhere. */
  function improve(P, routes, passes) {
    let moves = 0;
    for (let pass = 0; pass < passes; pass++) {
      let improved = false;
      for (const r of routes) {
        const unitsHere = [...new Set(r.seq.filter((x) => typeof x === 'string').map((id) => P.unitOf[id]))];
        for (const u of unitsHere) {
          if (r.lockedPrefix && u.tasks.some((id) => r.seq.indexOf(id) < r.lockedPrefix)) continue;
          const before = r.sim.cost;
          const seqWithout = removeUnit(r, u);
          const simWithout = simulate(P, r, seqWithout, { softAppointments: r.softAppointments });
          if (!simWithout.feasible) continue;
          const saving = before - simWithout.cost;
          const oldSeq = r.seq, oldSim = r.sim;
          r.seq = seqWithout; r.sim = simWithout;
          let best = null, bestR = null;
          for (const r2 of routes) {
            const ins = bestInsertion(P, r2, u);
            if (ins && (!best || ins.delta < best.delta)) { best = ins; bestR = r2; }
          }
          if (best && best.delta < saving - 1) {
            applyInsertion(P, bestR, best);
            improved = true; moves++;
          } else { r.seq = oldSeq; r.sim = oldSim; }
        }
      }
      if (!improved) break;
    }
    return moves;
  }

  // ------------------------------------------------------------------ freezing (time moves on)
  function freezeAt(P, route, t) {
    const sim = route.sim || evalRoute(P, route);
    if (!route.seq.length) {
      if (!route.state.started) route.state.time = Math.max(route.state.time, t);
      else if (route.state.atDepot) route.state.time = Math.max(route.state.time, t);
      return;
    }
    // a stop is committed once the truck has left for it (previous departure <= t)
    const departed = route.state.started ? route.state.time : sim.dutyStart + PRETRIP;
    let k = 0;
    while (k < sim.stops.length && (k === 0 ? departed : sim.stops[k - 1].dep) <= t) k++;
    if (k === 0) return; // still in the yard
    const doneStops = sim.stops.slice(0, k);
    const finished = k === sim.stops.length && sim.end <= t && sim.stops.length > 0;
    // rebuild the state by simulating the frozen prefix
    const prefix = route.seq.slice(0, k);
    const pre = simulate(P, route, prefix);
    const last = doneStops[doneStops.length - 1];
    doneStops.forEach((s, i) => route.done.push(Object.assign({}, s, { item: prefix[i] })));
    route.seq = route.seq.slice(k);
    const lastItem = prefix[prefix.length - 1];
    const lastPos = !lastItem ? P.depot : typeof lastItem === 'string' ? P.tasks[lastItem] : P.depot;
    {
      route.state = {
        lat: lastPos.lat, lng: lastPos.lng, time: last ? last.dep : t,
        drive: pre.drive - (last ? travelMin(roadKm(lastPos, P.depot)) : 0),
        km: pre.km - (last ? roadKm(lastPos, P.depot) : 0),
        loadW: last.loadW, loadS: last.loadS,
        atDepot: !last, dutyStart: pre.dutyStart, started: true,
        maxW: Math.max(route.state.maxW || 0, route.state.started ? 0 : sim.startW, ...doneStops.map((x) => x.loadW)),
        maxS: Math.max(route.state.maxS || 0, route.state.started ? 0 : sim.startS, ...doneStops.map((x) => x.loadS)),
        onboard: route.seq.slice(0, (route.seq.findIndex((x) => typeof x !== 'string') + 1 || route.seq.length + 1) - 1).filter((id) => P.tasks[id] && (P.tasks[id].kind === 'D' || P.tasks[id].kind === 'M')),
      };
      if (lastItem && typeof lastItem !== 'string') { route.state.atDepot = true; route.state.lat = null; route.state.lng = null; route.state.loadW = 0; route.state.loadS = 0; }
      // route finished: it is back in the yard and can take a second trip
      if (finished) route.seq = [{ depot: true, at: t }];
    }
    evalRoute(P, route);
  }

  function cloneRoutes(routes) {
    return routes.map((r) => JSON.parse(JSON.stringify(r)));
  }

  // ------------------------------------------------------------------ outputs
  function routeView(P, r) {
    const sim = r.sim || evalRoute(P, r);
    const v = VEHICLES[r.cls];
    const doneStops = r.done.map((s) => Object.assign({ status: 'done' }, s, s.item && typeof s.item !== 'string' ? { depot: true } : {}));
    const stops = doneStops.concat(sim.stops.map((s) => Object.assign({ status: 'planned' }, s)));
    const all = stops.filter((s) => !s.depot).map((s) => s.id);
    const used = all.length > 0;
    const full = used ? simulateFromScratchKpis(P, r, sim) : null;
    return {
      id: r.id, driver: r.driver, driverName: r.driverName, vehicle: r.vehicle, cls: r.cls, vehicleLabel: v.label,
      licence: r.licence, vehicleUnknown: r.vehicleUnknown, broken: r.broken || false,
      capacity: { lb: v.maxLb, spots: v.spots, feet: v.feet },
      stops: stops.map((s) => (s.depot ? { depot: true, arr: s.arr, dep: s.dep, status: s.status } : Object.assign(s, { live: r.insertedLive[s.id] || null, edited: (r.edited && r.edited[s.id]) || null }))),
      nStops: all.length,
      km: full ? full.km : 0, driveMin: full ? full.drive : 0, onDutyMin: full ? full.onDuty : 0,
      start: full ? full.dutyStart : null, end: full ? full.end : null,
      peakLb: full ? full.maxW : 0, peakSpots: full ? full.maxS : 0,
      utilLb: full ? Math.round((full.maxW / v.maxLb) * 100) : 0,
      utilSpots: full ? Math.round((full.maxS / v.spots) * 100) : 0,
      utilHours: full ? Math.round((full.onDuty / C.dutyMax) * 100) : 0,
      cost: full ? full.opCost : 0, lateMin: full ? full.late : 0,
      violations: sim.viol,
      loadPlan: used ? loadPlan(P, r, stops) : null,
    };
  }

  function simulateFromScratchKpis(P, r, sim) {
    // done prefix + pending sim: the state already carries the prefix's drive/km
    return sim;
  }

  /** LIFO deck plan: last delivery at the nose, first delivery at the door; pickups fill from the door. */
  function loadPlan(P, r, stops) {
    const v = VEHICLES[r.cls];
    const cells = v.spots;
    const firstSeg = [];
    for (const s of stops) { if (s.depot && firstSeg.length) break; if (!s.depot) firstSeg.push(s.id); }
    const drops = firstSeg.map((id, i) => ({ id, order: i + 1, t: P.tasks[id] })).filter((x) => x.t && (x.t.kind === 'D' || x.t.kind === 'M') && !x.t.pairedWith);
    const items = [];
    let cursor = 0, shared = 0;
    const toLoad = drops.slice().reverse(); // load the last delivery first
    toLoad.forEach((x, k) => {
      const sp = x.t.kind === 'M' ? x.t.dropSp : x.t.spots;
      const n = sp >= 1 ? Math.round(sp) : 0;
      const slot = [];
      if (n === 0) {
        if (shared === 0 || x.t.dg) { slot.push(cursor); shared = x.t.dg ? 0 : 1 - Math.max(sp, 0.25); cursor++; }
        else { slot.push(cursor - 1); shared -= Math.max(sp, 0.25); if (shared <= 0) shared = 0; }
      } else {
        for (let i = 0; i < n; i++) slot.push(cursor++);
        shared = 0;
      }
      items.push({ id: x.id, deliveryOrder: x.order, loadOrder: k + 1, cells: slot, weight: x.t.kind === 'M' ? x.t.dropW : x.t.weight, spots: sp, dg: x.t.dg, estimated: x.t.estimated.includes('skid_spots'), pieceType: x.t.pieceType });
    });
    const pickupsReserved = Math.max(0, Math.ceil(stops.filter((s) => !s.depot && P.tasks[s.id] && P.tasks[s.id].pickSp > 0).reduce((a, s) => a + P.tasks[s.id].pickSp, 0)));
    const notes = [];
    if (cursor > cells) notes.push(`Terminal freight needs ${cursor} spots but the deck has ${cells}: split across a reload.`);
    const dgW = drops.filter((x) => x.t.dg).reduce((a, x) => a + x.t.weight, 0);
    if (dgW > 0) notes.push(`Dangerous goods on board (${Math.round(dgW)} lb): load DG on the floor, secure separately, shipping documents in the cab${dgW > 1102 ? '; over 500 kg aggregate — check TDG placarding' : ''}.`);
    const heavy = drops.filter((x) => x.t.weight / Math.max(1, x.t.spots) > 2500);
    if (heavy.length) notes.push(`${heavy.length} dense skid(s) over 2,500 lb per spot: floor-load over the axles and strap down.`);
    notes.push('Load in the listed order: first item goes to the nose, last item sits at the door for the first delivery.');
    return { cells, rows: Math.ceil(cells / 2), used: Math.min(cursor, cells), overflow: Math.max(0, cursor - cells), pickupsReserved, items, notes };
  }

  function summarize(P, routes, partner, extras) {
    const views = routes.map((r) => routeView(P, r));
    const used = views.filter((v) => v.nStops > 0);
    const late = [];
    let appts = 0, apptsMet = 0;
    for (const v of used) for (const s of v.stops) {
      if (s.depot) continue;
      const t = P.tasks[s.id];
      if (s.late > 0) late.push({ id: s.id, route: v.id, by: s.late });
      if (t.hardLatest != null) { appts++; if (s.start <= t.hardLatest + 0.5) apptsMet++; }
    }
    const nStops = used.reduce((a, v) => a + v.nStops, 0);
    const km = used.reduce((a, v) => a + v.km, 0);
    const kpis = {
      trucksUsed: used.length,
      trucksAvailable: routes.length,
      stopsRouted: nStops,
      partnerShipments: partner.length,
      partnerCost: partner.reduce((a, x) => a + x.quote, 0),
      km: Math.round(km),
      driveHours: r1(used.reduce((a, v) => a + v.driveMin, 0) / 60),
      dutyHours: r1(used.reduce((a, v) => a + v.onDutyMin, 0) / 60),
      fleetCost: Math.round(used.reduce((a, v) => a + v.cost, 0)),
      onTimePct: nStops ? Math.round(((nStops - late.length) / nStops) * 1000) / 10 : 100,
      lateStops: late.length,
      appointments: appts, appointmentsMet: apptsMet,
      avgUtilLb: used.length ? Math.round(used.reduce((a, v) => a + v.utilLb, 0) / used.length) : 0,
      avgUtilSpots: used.length ? Math.round(used.reduce((a, v) => a + v.utilSpots, 0) / used.length) : 0,
      avgUtilHours: used.length ? Math.round(used.reduce((a, v) => a + v.utilHours, 0) / used.length) : 0,
      co2kg: Math.round(km * 0.95),
    };
    kpis.totalCost = kpis.fleetCost + kpis.partnerCost;
    kpis.equipmentMismatches = views.reduce((a, v) => a + v.violations.filter((x) => x.type === 'equipment').length, 0);
    kpis.overloadedTrucks = views.filter((v) => v.violations.some((x) => x.type === 'overweight' || x.type === 'overspots')).length;
    return Object.assign({ kpis, routes: views, partner, fleet: fleetMix(P, views) }, extras || {});
  }

  /** Per vehicle class: how many units ran, how full they ran and what kind of freight each class carried. */
  function fleetMix(P, views) {
    const rows = {};
    for (const cls of Object.keys(VEHICLES)) rows[cls] = { cls, label: VEHICLES[cls].label, short: VEHICLES[cls].short, maxLb: VEHICLES[cls].maxLb, maxSpots: VEHICLES[cls].spots, available: 0, used: 0, stops: 0, weight: 0, km: 0, dutyH: 0, utilLb: 0, utilSpots: 0, tractorOnly: 0, longHaul: 0, small: 0, tailgate: 0, heavy: 0, mismatches: 0, overloads: 0 };
    for (const v of views) {
      const row = rows[v.cls];
      row.available++;
      if (!v.nStops) continue;
      row.used++; row.stops += v.nStops; row.km += v.km; row.dutyH += v.onDutyMin / 60; row.utilLb += v.utilLb; row.utilSpots += v.utilSpots;
      for (const s of v.stops) {
        if (s.depot) continue;
        const t = P.tasks[s.id];
        if (!t) continue;
        row.weight += t.weight || 0;
        if (t.allowed && t.allowed.length === 1 && t.allowed[0] === 'TRACTOR_53') row.tractorOnly++;
        if (t.depotKm > 150) row.longHaul++;
        if (t.weight < 500) row.small++;
        if (t.weight >= 5000 || t.spots >= 6) row.heavy++;
        if ((t.handling || []).some((h) => /tailgate|residential/.test(h))) row.tailgate++;
      }
      row.mismatches += v.violations.filter((x) => x.type === 'equipment').length;
      row.overloads += v.violations.some((x) => x.type === 'overweight' || x.type === 'overspots') ? 1 : 0;
    }
    return Object.values(rows).filter((r) => r.available > 0).map((r) => Object.assign(r, {
      utilLb: r.used ? Math.round(r.utilLb / r.used) : 0, utilSpots: r.used ? Math.round(r.utilSpots / r.used) : 0,
      stopsPerTruck: r.used ? r1(r.stops / r.used) : 0, weightPerTruck: r.used ? Math.round(r.weight / r.used) : 0,
      kmPerTruck: r.used ? Math.round(r.km / r.used) : 0, km: Math.round(r.km), dutyH: r1(r.dutyH), weight: Math.round(r.weight), standby: r.available - r.used,
    }));
  }

  // ------------------------------------------------------------------ dispatcher edits (custom plans)
  function rebuildPlan(plan, routes, partner) {
    const P = plan._P;
    const keep = {};
    for (const k of Object.keys(plan)) if (!['kpis', 'routes', 'partner', 'fleet', '_P', '_routes'].includes(k)) keep[k] = plan[k];
    for (const r of routes) evalRoute(P, r);
    const out = summarize(P, routes, partner, keep);
    out._P = P; out._routes = routes;
    return out;
  }

  /** Moves a stop (with its paired leg) to another route or to a partner carrier. The dispatcher's call wins: the move is
   * applied even when it breaks a rule, and the impact plus any broken rules are reported back. */
  function moveStop(plan, taskId, target) {
    const P = plan._P;
    C = P.cfg;
    const u = P.unitOf[taskId];
    if (!u) throw Object.assign(new Error(`Unknown stop ${taskId}`), { status: 400 });
    const routes = plan._routes;
    const partner = plan.partner.slice();
    const from = routes.find((r) => r.seq.includes(taskId));
    const pIdx = partner.findIndex((p) => p.tasks.includes(taskId));
    if ((from && from.id === target) || (pIdx >= 0 && target === 'PARTNER')) throw Object.assign(new Error('The stop is already there'), { status: 400 });
    const snap = (r) => (r ? { id: r.id, driver: r.driverName, km: r.sim.km, end: r.sim.end, onDuty: r.sim.onDuty, stops: r.seq.filter((x) => typeof x === 'string').length, hard: r.sim.viol.filter((v) => v.hard).map((v) => v.type) } : null);
    const beforeKpis = plan.kpis;
    let to = null;
    if (target !== 'PARTNER') {
      to = routes.find((r) => r.id === target);
      if (!to) throw Object.assign(new Error(`Unknown route ${target}`), { status: 400 });
      evalRoute(P, to);
    }
    if (from) evalRoute(P, from);
    const fromBefore = snap(from), toBefore = snap(to);
    if (from) { from.seq = removeUnit(from, u); evalRoute(P, from); }
    if (pIdx >= 0) partner.splice(pIdx, 1);
    if (!to) {
      partner.push({ unit: u.id, tasks: u.tasks, quote: u.tasks.reduce((a, id) => a + partnerQuote(P.tasks[id], P.depot), 0), reason: 'Tendered by the dispatcher (manual edit).' });
    } else {
      let best = null;
      for (const sq of candidateSeqs(P, to, u)) {
        const sim = simulate(P, to, sq, { softAppointments: to.softAppointments });
        const score = sim.viol.filter((v) => v.hard).length * 1e6 + sim.cost;
        if (!best || score < best.score) best = { score, seq: sq, sim };
      }
      to.seq = best.seq; to.sim = best.sim;
      to.edited = to.edited || {};
      u.tasks.forEach((id) => (to.edited[id] = true));
    }
    const out = rebuildPlan(plan, routes, partner);
    const toRoute = to && out.routes.find((r) => r.id === to.id);
    const impact = {
      task: taskId, label: unitLabel(P, u), target,
      from: from ? Object.assign(fromBefore, { after: snap(from) }) : pIdx >= 0 ? { id: 'PARTNER' } : null,
      to: to ? Object.assign(toBefore, { after: snap(to) }) : { id: 'PARTNER' },
      deltaCost: out.kpis.totalCost - beforeKpis.totalCost, deltaKm: out.kpis.km - beforeKpis.km,
      deltaLate: out.kpis.lateStops - beforeKpis.lateStops,
      brokenRules: toRoute ? [...new Set(toRoute.violations.filter((v) => v.hard).map((v) => v.type))] : [],
      equipmentOk: to ? u.allowed.includes(to.cls) : true,
    };
    out.decisions = (plan.decisions || []).concat([{
      seq: (plan.decisions || []).length + 1, time: null, type: 'manual_edit', subject: impact.label, route: to ? to.id : undefined,
      decision: `Dispatcher moved it ${from ? `from ${from.id} ` : pIdx >= 0 ? 'from partner ' : ''}to ${to ? `${to.id} (${to.driverName})` : 'a partner carrier'}`,
      reason: `${impact.deltaCost >= 0 ? '+' : '−'}$${Math.abs(Math.round(impact.deltaCost))} day cost, ${impact.deltaKm >= 0 ? '+' : '−'}${Math.abs(impact.deltaKm)} km${impact.brokenRules.length ? ` · breaks: ${impact.brokenRules.join(', ')}` : ' · all rules still pass'}.`,
      confidence: impact.brokenRules.length ? 'low' : 'high',
    }]);
    if (out.custom) out.custom = Object.assign({}, out.custom, { moves: (out.custom.moves || []).concat([{ task: taskId, target }]), edits: (out.custom.edits || []).concat([impact]) });
    return { plan: out, impact };
  }

  /** A custom plan is a recipe: a starting point, optional settings and a list of dispatcher moves. Rebuilding it is deterministic. */
  function buildCustomPlan(day, recipe) {
    recipe = recipe || {};
    let plan;
    if (recipe.base === 'manual') plan = manualPlan(day);
    else if (recipe.base === 'copilot') plan = planDay(day, { dynamic: true });
    else plan = planDay(day, { dynamic: !(recipe.settings && recipe.settings.liveReplay === false), settings: recipe.settings });
    plan.custom = { id: recipe.id, name: recipe.name || 'Custom plan', base: recipe.base || 'optimise', settings: plan._P.cfg.settings, objective: Object.assign({ key: plan._P.cfg.objective }, OBJECTIVES[plan._P.cfg.objective]), moves: [], edits: [], created: recipe.created };
    for (const m of recipe.moves || []) {
      try { plan = moveStop(plan, m.task, m.target).plan; } catch (e) { plan.custom.edits = plan.custom.edits.concat([{ task: m.task, target: m.target, error: e.message }]); }
    }
    return plan;
  }


  function taskView(t) {
    return {
      id: t.id, orders: t.orders, kind: t.kind, customer: t.customer, address: t.address, city: t.city, prov: t.prov,
      lat: t.lat, lng: t.lng, weight: t.weight, pieces: t.pieces, pieceType: t.pieceType, spots: t.spots, feet: t.feet,
      service: t.service, equipment: t.equipment, handling: t.handling, appt: t.appt, release: t.release,
      earliest: t.earliest, latest: t.latest, hardLatest: t.hardLatest, serviceMin: t.serviceMin,
      allowed: t.allowed, estimated: t.estimated, issues: t.issues, pairedWith: t.pairedWith || null, dg: t.dg,
      depotKm: t.depotKm, hist: t.hist,
    };
  }

  // ------------------------------------------------------------------ plan the day
  function planDay(day, options) {
    options = options || {};
    const t0 = Date.now();
    const P = buildProblem(day, options.depot, makeCfg(options.settings));
    const decisions = [];
    const log = (d) => decisions.push(Object.assign({ seq: decisions.length + 1 }, d));
    const include = P.cfg.settings.drivers;
    const drivers = day.drivers.filter((d) => !(options.excludeDrivers || []).includes(d.code) && (!include || include.includes(d.code)));
    const routes = drivers.map((d, i) => makeRoute(d, i));

    // 1. partner pre-pass (outside the in-house network)
    const partner = [];
    const inHouse = [];
    for (const u of P.units) {
      if (u.partnerOnly) {
        const quote = u.tasks.reduce((a, id) => a + partnerQuote(P.tasks[id], P.depot), 0);
        partner.push({ unit: u.id, tasks: u.tasks, quote, reason: `Destination outside the Ontario/Quebec network (${u.tasks.map((id) => P.tasks[id].prov).join('/')}) — tender to partner carrier.` });
        log({ time: DAY_START, type: 'partner', subject: unitLabel(P, u), decision: 'Tender to partner carrier', reason: `Outside ON/QC service area; indicative quote $${quote}.`, confidence: 'high' });
      } else inHouse.push(u);
    }

    // 2. morning plan: terminal freight + pickups already known at 07:00
    const known = inHouse.filter((u) => u.release <= C.depart || !options.dynamic);
    const late = inHouse.filter((u) => !known.includes(u)).sort((a, b) => a.release - b.release);
    let failed = regretInsert(P, routes, known, {
      onInsert: (u, r, ins) => log({ time: DAY_START, type: 'assign', subject: unitLabel(P, u), route: r.id, decision: `Assign to ${r.id} (${r.driverName}, ${VEHICLES[r.cls].short})`, reason: explainInsert(P, u, r, ins), confidence: 'high' }),
    });
    const moves = improve(P, routes, 2);
    if (moves) log({ time: DAY_START, type: 'improve', subject: `${moves} relocations`, decision: `Local search moved ${moves} shipments between routes`, reason: 'Each move lowered total route cost while keeping every route feasible.', confidence: 'high' });
    failed = retrySoft(P, routes, failed, log, DAY_START);
    for (const u of failed) addPartner(P, partner, u, log, DAY_START, 'No in-house vehicle can take it within capacity, equipment, HOS and appointment limits.');

    // 3. economic check: far, light freight is cheaper with a partner
    if (P.cfg.allowPartner) partnerEconomics(P, routes, partner, log);
    for (const r of routes) evalRoute(P, r);
    const morning = summarize(P, cloneRoutes(routes).map((r) => Object.assign(r, { insertedLive: {} })), partner.slice());

    // 4. live replay: each call-in pickup inserted at its real dispatch time
    const live = [];
    if (options.dynamic) {
      for (const u of late) {
        for (const r of routes) freezeAt(P, r, u.release);
        let ins = routes.map((r) => ({ r, x: bestInsertion(P, r, u, { strictPromises: true }) })).filter((c) => c.x).sort((a, b) => a.x.delta - b.x.delta);
        if (!ins.length) ins = routes.map((r) => ({ r, x: bestInsertion(P, r, u) })).filter((c) => c.x).sort((a, b) => a.x.delta - b.x.delta);
        if (ins.length) {
          applyInsertion(P, ins[0].r, ins[0].x);
          u.tasks.forEach((id) => (ins[0].r.insertedLive[id] = u.release));
          const alt = ins[1] ? ` Next best: ${ins[1].r.id} (+$${Math.round(ins[1].x.delta - ins[0].x.delta)} more).` : '';
          log({ time: u.release, type: 'live_insert', subject: unitLabel(P, u), route: ins[0].r.id, decision: `Live: add to ${ins[0].r.id} (${ins[0].r.driverName})`, reason: explainInsert(P, u, ins[0].r, ins[0].x) + alt, confidence: ins.length > 1 ? 'high' : 'medium' });
          live.push({ unit: u.id, tasks: u.tasks, at: u.release, route: ins[0].r.id });
        } else {
          const soft = routes.map((r) => ({ r, x: bestInsertion(P, r, u, { softAppointments: true }) })).filter((c) => c.x).sort((a, b) => a.x.delta - b.x.delta);
          if (soft.length) {
            soft[0].r.softAppointments = true;
            applyInsertion(P, soft[0].r, soft[0].x);
            u.tasks.forEach((id) => (soft[0].r.insertedLive[id] = u.release));
            log({ time: u.release, type: 'live_insert', subject: unitLabel(P, u), route: soft[0].r.id, decision: `Live: add to ${soft[0].r.id} — appointment will be missed`, reason: 'No route reaches the appointment window. Call the customer to rebook before committing.', confidence: 'low' });
            live.push({ unit: u.id, tasks: u.tasks, at: u.release, route: soft[0].r.id });
          } else addPartner(P, partner, u, log, u.release, 'Called in too late for any in-house route to absorb within HOS limits.');
        }
      }
    }
    for (const r of routes) unfreeze(P, r);
    const out = summarize(P, routes, partner, {
      date: day.date, mode: options.dynamic ? 'dynamic' : 'static', settings: P.cfg.settings,
      decisions, live, morningKpis: morning.kpis,
      tasks: Object.values(P.tasks).map(taskView),
      runtimeMs: Date.now() - t0,
    });
    out._P = P; out._routes = routes;
    return out;
  }

  function retrySoft(P, routes, failed, log, time) {
    if (!failed.length) return failed;
    const stillFailed = [];
    for (const u of failed) {
      const hasAppt = u.tasks.some((id) => P.tasks[id].hardLatest != null);
      if (!hasAppt) { stillFailed.push(u); continue; }
      const c = routes.map((r) => ({ r, x: bestInsertion(P, r, u, { softAppointments: true }) })).filter((c) => c.x).sort((a, b) => a.x.delta - b.x.delta);
      if (!c.length) { stillFailed.push(u); continue; }
      c[0].r.softAppointments = true;
      applyInsertion(P, c[0].r, c[0].x);
      log({ time, type: 'assign', subject: unitLabel(P, u), route: c[0].r.id, decision: `Assign to ${c[0].r.id} but appointment cannot be met`, reason: 'No vehicle can reach the appointment window from the terminal. Recommend calling the customer to move the appointment.', confidence: 'low' });
    }
    return stillFailed;
  }

  function addPartner(P, partner, u, log, time, why) {
    const quote = u.tasks.reduce((a, id) => a + partnerQuote(P.tasks[id], P.depot), 0);
    partner.push({ unit: u.id, tasks: u.tasks, quote, reason: why });
    log({ time, type: 'partner', subject: unitLabel(P, u), decision: 'Tender to partner carrier', reason: `${why} Indicative quote $${quote}.`, confidence: 'medium' });
  }

  function partnerEconomics(P, routes, partner, log) {
    for (const r of routes) {
      evalRoute(P, r);
      const unitsHere = [...new Set(r.seq.filter((x) => typeof x === 'string').map((id) => P.unitOf[id]))];
      for (const u of unitsHere) {
        if (u.tasks.some((id) => P.tasks[id].depotKm < 150)) continue;
        const without = simulate(P, r, removeUnit(r, u));
        if (!without.feasible) continue;
        const saving = r.sim.cost - without.cost;
        const quote = u.tasks.reduce((a, id) => a + partnerQuote(P.tasks[id], P.depot), 0);
        if (saving > quote * 1.15) {
          r.seq = removeUnit(r, u); evalRoute(P, r);
          partner.push({ unit: u.id, tasks: u.tasks, quote, reason: `In-house marginal cost $${Math.round(saving)} vs partner $${quote}.` });
          log({ time: DAY_START, type: 'partner', subject: unitLabel(P, u), decision: 'Tender to partner carrier (cheaper)', reason: `Serving it in-house adds $${Math.round(saving)} (${Math.round(P.tasks[u.tasks[0]].depotKm)} km from terminal, ${u.weight} lb). Partner quote $${quote}.`, confidence: 'medium' });
        }
      }
    }
  }

  function unitLabel(P, u) {
    return u.tasks.map((id) => { const t = P.tasks[id]; return `${(t.orders || [id]).join('/')} ${t.kind === 'P' ? 'pickup' : t.kind === 'M' ? 'pickup+drop' : 'delivery'} ${t.city || ''}`.trim(); }).join(' → ');
  }

  function explainInsert(P, u, r, ins) {
    const t = P.tasks[u.tasks[u.tasks.length - 1]];
    const idx = ins.seq.indexOf(u.tasks[0]);
    const prev = idx > 0 ? ins.seq[idx - 1] : null;
    const prevT = typeof prev === 'string' ? P.tasks[prev] : null;
    const st = ins.sim.stops.find((s) => s.id === u.tasks[0]);
    const v = VEHICLES[r.cls];
    const bits = [];
    if (prevT) bits.push(`${r1(roadKm(prevT, P.tasks[u.tasks[0]]))} km from previous stop (${prevT.city || prevT.address.split(' ').slice(-4, -3)[0] || 'nearby'})`);
    else bits.push(`first stop out of the terminal (${t.depotKm} km)`);
    if (st) bits.push(`ETA ${hhmm(st.arr)}${t.hardLatest != null ? ` within appointment ≤ ${hhmm(t.hardLatest)}` : ''}`);
    bits.push(`peak load ${Math.round((ins.sim.maxW / v.maxLb) * 100)}% weight / ${Math.round((ins.sim.maxS / v.spots) * 100)}% spots`);
    bits.push(`${r1(ins.sim.drive / 60)} h driving, ${r1(ins.sim.onDuty / 60)} h on duty`);
    if (u.tasks.length === 2) bits.push('pickup sequenced before its own delivery');
    if (!t.allowed.includes('TRACTOR_53') || t.allowed.length === 1) bits.push(`needs ${t.allowed.map((c) => VEHICLES[c].short).join(' or ')}`);
    return bits.join(' · ') + ` · +$${Math.round(ins.delta)} marginal cost.`;
  }

  // ------------------------------------------------------------------ manual (as dispatched) baseline
  function manualPlan(day, options) {
    options = options || {};
    const P = buildProblem(day, options.depot, makeCfg());
    const byDriver = {};
    for (const t of Object.values(P.tasks)) {
      const code = t.hist.driver;
      (byDriver[code] = byDriver[code] || []).push(t);
    }
    const drvMap = Object.fromEntries(day.drivers.map((d) => [d.code, d]));
    const routes = [];
    Object.keys(byDriver).sort().forEach((code, i) => {
      const d = drvMap[code] || { code, name: 'Driver ' + code, vehicle: byDriver[code][0].hist.vehicle, vehicleClass: 'STRAIGHT_26', licence: 'DZ' };
      const r = makeRoute(d, i);
      r.id = 'M' + String(i + 1).padStart(2, '0');
      const list = byDriver[code].slice().sort((a, b) => (a.hist.arr ?? 1e9) - (b.hist.arr ?? 1e9));
      // a new Samsara route for the same driver ≈ back through the terminal
      let prevRoute = null;
      for (const t of list) {
        if (prevRoute && t.hist.route !== prevRoute && !t.isPickup) r.seq.push({ depot: true, at: 0 });
        r.seq.push(t.id); prevRoute = t.hist.route;
      }
      r.state.time = C.depart;
      r.softAppointments = true;
      r.actual = d.actual || null;
      evalRoute(P, r);
      routes.push(r);
    });
    const out = summarize(P, routes, [], { date: day.date, decisions: [], tasks: Object.values(P.tasks).map(taskView) });
    out.actual = day.actualSummary;
    out._P = P; out._routes = routes;
    return out;
  }

  // ------------------------------------------------------------------ conflict detection
  function detectConflicts(plan, day, which) {
    const P = plan._P;
    C = P.cfg;
    const out = [];
    const add = (sev, cat, title, detail, fix, refs) => out.push({ id: `${which}-${out.length + 1}`, severity: sev, category: cat, title, detail, fix, refs: refs || {} });
    for (const r of plan.routes) {
      if (!r.nStops) continue;
      for (const v of r.violations) {
        if (v.type === 'overweight') add('critical', 'Capacity', `${r.id} overloaded by ${v.by.toLocaleString()} lb`, `${r.vehicle} (${r.vehicleLabel}) peaks at ${r.peakLb.toLocaleString()} lb vs ${r.capacity.lb.toLocaleString()} lb payload.`, 'Move the heaviest drop to a tractor route or add a terminal reload.', { route: r.id });
        if (v.type === 'overspots') add('critical', 'Capacity', `${r.id} needs ${r.peakSpots} skid spots (${r.capacity.spots} available)`, `Floor space exceeded on ${r.vehicle}.`, 'Split the load or upgrade to a 53′ trailer.', { route: r.id });
        if (v.type === 'hos_drive') add('critical', 'Hours of service', `${r.driverName} over 13 h driving by ${v.by} min`, `Modelled driving ${r1(r.driveMin / 60)} h on ${r.id}.`, 'Hand the farthest stops to another driver or a partner.', { route: r.id, driver: r.driver });
        if (v.type === 'hos_duty') add('critical', 'Hours of service', `${r.driverName} over 14 h on duty by ${v.by} min`, `Shift ${hhmm(r.start)}–${hhmm(r.end)} on ${r.id}.`, 'Move late pickups to a driver with hours left.', { route: r.id, driver: r.driver });
        if (v.type === 'equipment') { const t = P.tasks[v.task]; add('critical', 'Equipment', `${t.orders.join(', ')} needs ${t.allowed.map((c) => VEHICLES[c].short).join(' / ')}`, `Assigned to ${r.vehicle} (${r.vehicleLabel}). Requested: ${(t.equipment || []).join(', ') || '—'}; handling: ${(t.handling || []).join(', ') || '—'}.`, 'Reassign to a compatible unit.', { route: r.id, task: v.task }); }
      }
      for (const s of r.stops) {
        if (s.depot) continue;
        const t = P.tasks[s.id];
        if (t.hardLatest != null && s.start > t.hardLatest + 0.5) add('critical', 'Delivery window', `Appointment missed: ${t.orders.join(', ')}`, `${t.customer}, ${t.city || ''}: appointment ${hhmm(t.appt)}, modelled arrival ${hhmm(s.arr)} on ${r.id} (${Math.round(s.start - t.appt)} min late).`, 'Re-sequence, swap to a closer route, or call the customer to rebook now.', { route: r.id, task: s.id });
        else if (t.hardLatest != null && t.hardLatest - s.start < 15) add('warning', 'Delivery window', `Tight appointment: ${t.orders.join(', ')}`, `Arrival ${hhmm(s.start)} vs latest ${hhmm(t.hardLatest)} — less than 15 min buffer.`, 'Keep this stop early or warn the receiver.', { route: r.id, task: s.id });
        else if (s.late > 30) add('warning', 'Service promise', `${t.orders.join(', ')} ${s.late} min past promise`, `${(t.service || []).join(', ')} promise ${hhmm(t.latest)}, modelled ${hhmm(s.start)} on ${r.id}.`, 'Prioritise or move to a route with slack.', { route: r.id, task: s.id });
        if (t.dg && r.cls === 'CARGO_VAN') add('critical', 'Dangerous goods', `Dangerous goods on a van: ${t.orders.join(', ')}`, 'TDG shipments should move in a commercial unit with documents and securement.', 'Reassign to a straight truck.', { route: r.id, task: s.id });
      }
      if (r.loadPlan && r.loadPlan.items.some((i) => i.dg)) {
        const dgW = r.loadPlan.items.filter((i) => i.dg).reduce((a, i) => a + i.weight, 0);
        add(dgW > 1102 ? 'warning' : 'info', 'Dangerous goods', `${r.id} carries dangerous goods (${Math.round(dgW)} lb)`, `Driver ${r.driverName} must have TDG training and shipping documents in reach${dgW > 1102 ? '; over 500 kg aggregate → placards likely required' : ''}.`, 'Confirm TDG certificate and placards before departure.', { route: r.id });
      }
      if (r.vehicleUnknown) add('warning', 'Missing data', `${r.driverName} has no vehicle on record`, 'No unit in the vehicle log or HOS log for this driver-day; capacity assumed to be a 26′ straight truck.', 'Record the unit in Samsara before dispatch.', { route: r.id });
      if (r.utilLb < 15 && r.nStops <= 2 && which === 'manual') add('info', 'Utilization', `${r.id} (${r.driverName}) under-used`, `${r.nStops} stop(s), peak ${r.utilLb}% of payload.`, 'Candidate to consolidate into a neighbouring route.', { route: r.id });
    }
    // consolidation: same address split across drivers
    const byAddr = {};
    for (const r of plan.routes) for (const s of r.stops) if (!s.depot) {
      const t = P.tasks[s.id];
      const key = `${t.lat.toFixed(3)},${t.lng.toFixed(3)}`;
      (byAddr[key] = byAddr[key] || new Set()).add(r.id);
    }
    const splitSites = Object.entries(byAddr).filter(([, set]) => set.size > 1);
    if (splitSites.length) add('info', 'Consolidation', `${splitSites.length} sites visited by more than one truck`, `The same address was served by 2+ routes on ${day.date}. Consolidating saves a stop and a dock wait each time.`, 'Let the copilot co-load visits to the same site.', { sites: splitSites.length });
    // data quality
    const est = Object.values(P.tasks);
    const missSpots = est.filter((t) => t.estimated.includes('skid_spots')).length;
    const missW = est.filter((t) => t.estimated.includes('weight'));
    const badAppt = est.filter((t) => t.issues.includes('appointment_invalid'));
    const noApptTime = est.filter((t) => t.estimated.includes('appointment_time'));
    if (missSpots) add('warning', 'Missing data', `${missSpots} of ${est.length} stops have no skid-spot count`, 'Elite SPOTS is blank; the copilot estimated floor space from weight and piece type (marked ESTIMATED).', 'Make SPOTS / FEET mandatory at order entry or scan dimensions at the dock.', { count: missSpots });
    if (missW.length) add('warning', 'Missing data', `${missW.length} stops with no usable weight`, `Weight blank or ≤ 1 lb (e.g. ${missW.slice(0, 3).map((t) => t.orders[0]).join(', ')}); estimated at 150 lb per piece.`, 'Weigh at the dock before loading.', { tasks: missW.map((t) => t.id) });
    if (badAppt.length) add('warning', 'Missing data', `${badAppt.length} appointment times look wrong`, `Appointment parsed outside 05:00–23:00 (e.g. ${badAppt.slice(0, 3).map((t) => t.orders[0]).join(', ')}); ignored for planning.`, 'Fix the Appt line in the order notes.', { tasks: badAppt.map((t) => t.id) });
    if (noApptTime.length) add('info', 'Missing data', `${noApptTime.length} orders flagged APPOINT without a time`, 'Elite APPOINT = 1 but no appointment time in the notes; treated as no window.', 'Capture the appointment time in Elite.', { tasks: noApptTime.map((t) => t.id) });
    const heavy = est.filter((t) => t.issues.includes('weight_over_payload'));
    if (heavy.length) add('warning', 'Missing data', `${heavy.length} order(s) declare more than a 53′ payload`, `${heavy.slice(0, 3).map((t) => `${t.orders[0]} (${t.declaredWeight.toLocaleString()} lb)`).join(', ')} — planned as one dedicated trailer at ${VEHICLES.TRACTOR_53.maxLb.toLocaleString()} lb.`, 'Verify the weight on the bill of lading; over-weight loads need a permit or a second trailer.', { tasks: heavy.map((t) => t.id) });
    const eqc = est.filter((t) => t.issues.includes('equipment_conflict'));
    if (eqc.length) add('warning', 'Equipment', `${eqc.length} orders need a 53′ trailer but also tailgate/residential handling`, eqc.slice(0, 3).map((t) => t.orders[0]).join(', '), 'Confirm with the customer whether a straight truck or a liftgate trailer is required.', { tasks: eqc.map((t) => t.id) });
    if (which === 'manual' && day.drivers) {
      const odd = day.drivers.filter((d) => d.actual && d.actual.driveMin > (d.actual.onDutyMin || 0) + 30 && d.actual.onDutyMin > 0);
      if (odd.length) add('info', 'Missing data', `${odd.length} HOS logs show more driving than on-duty time`, `e.g. ${odd.slice(0, 3).map((d) => d.name).join(', ')} — the ELD day log is incomplete or split.`, 'Review ELD edits; plan from the copilot\'s modelled hours meanwhile.', {});
      const multiDay = day.drivers.filter((d) => d.actual && d.actual.spanMin > 1440);
      if (multiDay.length) add('info', 'Missing data', `${multiDay.length} driver-day(s) span more than 24 h`, `e.g. ${multiDay.slice(0, 2).map((d) => `${d.name} (${r1(d.actual.spanMin / 60)} h)`).join(', ')} — a trip route kept open across days.`, 'Close trip routes in Samsara when the trip ends.', {});
      const longSpan = day.drivers.filter((d) => d.actual && d.actual.spanMin > 840 && d.actual.spanMin <= 1440);
      for (const d of longSpan) add('critical', 'Hours of service', `${d.name}: first-to-last stop span ${r1(d.actual.spanMin / 60)} h`, 'Recorded span exceeds the 14 h on-duty window.', 'Verify ELD and split the work across two drivers next time.', { driver: d.code });
      const missed = est.filter((t) => t.hist.apptDelta != null && t.hist.apptDelta > 15);
      if (missed.length) add('critical', 'Delivery window', `${missed.length} appointments actually missed (GPS)`, `Arrived more than 15 min after the appointment: ${missed.slice(0, 4).map((t) => `${t.orders[0]} (+${Math.round(t.hist.apptDelta)} min)`).join(', ')}.`, 'These are the deliveries the copilot protects with hard windows.', { tasks: missed.map((t) => t.id) });
    }
    const order = { critical: 0, warning: 1, info: 2 };
    out.sort((a, b) => order[a.severity] - order[b.severity]);
    return out;
  }

  // ------------------------------------------------------------------ disruptions
  function scenarioCatalog(plan, day) {
    const busy = plan.routes.filter((r) => r.nStops >= 5).sort((a, b) => b.nStops - a.nStops);
    // breakdown at 11:30: pick a straight truck that is mid-route with deliveries still on board
    // breakdown: the moment a straight truck has the most terminal freight still on board (09:00–14:00)
    let brk = busy[0], brkTime = 690, brkDrops = -1;
    for (const r of busy.filter((x) => x.cls === 'STRAIGHT_26')) {
      r.stops.forEach((s, i) => {
        if (s.depot || i === 0 || s.dep < 540 || s.dep > 840) return;
        let n = 0;
        for (const s2 of r.stops.slice(i + 1)) { if (s2.depot) break; const t = plan._P.tasks[s2.id]; if (t.kind === 'D' && !t.pairedWith) n++; }
        if (n > brkDrops) { brkDrops = n; brk = r; brkTime = s.dep + 10; }
      });
    }
    const sick = busy.filter((r) => r !== brk && r.cls === 'STRAIGHT_26' && r.stops.some((s) => !s.depot && s.arr < 600)).sort((a, b) => b.nStops - a.nStops)[0] || busy[1] || busy[0];
    // failed delivery: a late-morning drop on the route with the most hours left, so a same-day retry is a real option
    const isDrop = (s) => !s.depot && plan._P.tasks[s.id].kind === 'D' && !plan._P.tasks[s.id].pairedWith && s.arr > 600 && s.arr < 800;
    const slack = plan.routes.filter((r) => r.nStops >= 3 && r !== brk && r !== sick && r.stops.some(isDrop)).sort((a, b) => a.onDutyMin - b.onDutyMin);
    const failed = slack.length ? slack[0].stops.find(isDrop) : busy[0].stops.find((s) => !s.depot);
    const P = plan._P;
    const hotPair = (day.pairs || []).map(([p, d]) => [P.tasks[p], P.tasks[d]]).find(([p, d]) => p && d && p.rush && p.release > 660 && p.release < 840);
    return [
      { type: 'breakdown', title: 'Truck breakdown', icon: 'wrench', route: brk.id, time: brkTime, description: `${brk.vehicle} (${brk.driverName}) breaks down at ${hhmm(brkTime)} with ${brkDrops} deliveries still on board.` },
      { type: 'driver_absent', title: 'Driver calls in sick', icon: 'user-x', route: sick.id, time: 375, description: `${sick.driverName} calls in sick at 06:15; ${sick.nStops} stops have no driver.` },
      { type: 'hot_order', title: 'Late rush shipment', icon: 'zap', time: 780, pickup: hotPair ? hotPair[0].id : null, description: hotPair ? `RUSH pickup at ${hotPair[0].city} → ${hotPair[1].city} called in at 13:00, due within 4 h.` : 'RUSH shipment called in at 13:00.' },
      { type: 'failed_delivery', title: 'Failed delivery', icon: 'x-circle', task: failed ? failed.id : null, time: failed ? failed.dep : 720, description: failed ? `Receiver closed at ${P.tasks[failed.id].city} (${P.tasks[failed.id].orders[0]}). Freight still on the truck.` : 'Receiver closed.' },
    ];
  }

  function disrupt(day, event, options) {
    options = options || {};
    const base = options.basePlan || planDay(day, { dynamic: true });
    const P = base._P;
    C = P.cfg;
    const t = event.time != null ? event.time : 690;
    // the real order behind a hot-order what-if is taken out of the plan before the clock is frozen
    let hotSrc = null;
    if (event.type === 'hot_order' && event.pickup && P.tasks[event.pickup] && P.tasks[event.pickup].pairedWith) hotSrc = [event.pickup, P.tasks[event.pickup].pairedWith];
    const freshRoutes = () => {
      const rs = cloneRoutes(base._routes);
      for (const r of rs) {
        if (hotSrc) r.seq = r.seq.filter((x) => x !== hotSrc[0] && x !== hotSrc[1]);
        r.sim = null; evalRoute(P, r); freezeAt(P, r, t);
      }
      return rs;
    };
    const hardCount = (plan) => plan.routes.reduce((a, r) => a + r.violations.filter((v) => v.hard).length, 0);
    // baseline = the current plan frozen at the moment of the event, before any recovery action
    const basePlanAtT = summarize(P, freshRoutes(), base.partner.slice());
    const baseK = basePlanAtT.kpis;
    const baseHard = hardCount(basePlanAtT);
    const options_ = [];
    const mk = (id, title, routes, partner, actions, explanation, extra) => {
      const plan = summarize(P, routes, partner);
      const k = plan.kpis;
      const deltaCost = k.totalCost - baseK.totalCost;
      const deltaLate = k.lateStops - baseK.lateStops;
      const feasible = hardCount(plan) <= baseHard;
      options_.push(Object.assign({ id, title, actions, explanation, kpis: k, delta: { cost: deltaCost, km: k.km - baseK.km, lateStops: deltaLate, partner: k.partnerShipments - baseK.partnerShipments, trucks: k.trucksUsed - baseK.trucksUsed }, feasible, score: deltaCost + Math.max(0, deltaLate) * 150 + (feasible ? 0 : 1e5), plan: { routes: plan.routes, partner: plan.partner, kpis: plan.kpis } }, extra || {}));
    };

    if (event.type === 'breakdown' || event.type === 'driver_absent') {
      const rid = event.route;
      // ---- Option A: redistribute across the fleet
      {
        const rs = freshRoutes();
        const br = rs.find((r) => r.id === rid);
        const onBoardDrops = br.seq.filter((x) => typeof x === 'string' && (P.tasks[x].kind === 'D' || P.tasks[x].kind === 'M'));
        const units = [...new Set(br.seq.filter((x) => typeof x === 'string').map((id) => P.unitOf[id]))];
        br.seq = []; br.broken = true; evalRoute(P, br);
        const others = rs.filter((r) => r !== br);
        let rescue = null;
        const actions = [];
        if (event.type === 'breakdown' && br.state.started && !br.state.atDepot && onBoardDrops.length) {
          // freight on board: the closest route with room collects it at the breakdown site, then delivers it
          const site = { lat: br.state.lat, lng: br.state.lng };
          const w = onBoardDrops.reduce((a, id) => a + (P.tasks[id].dropW || P.tasks[id].weight), 0);
          const sp = onBoardDrops.reduce((a, id) => a + (P.tasks[id].dropSp || P.tasks[id].spots), 0);
          const rescueId = 'XFER-' + rid;
          P.tasks[rescueId] = { id: rescueId, kind: 'P', lat: site.lat, lng: site.lng, pickW: w, pickSp: sp, dropW: 0, dropSp: 0, weight: w, spots: sp, earliest: t + 20, latest: t + 240, hardLatest: null, serviceMin: 20 + Math.round(sp * 3), allowed: ['STRAIGHT_26', 'TRACTOR_53'], estimated: [], issues: [], orders: ['TRANSFER'], customer: 'Breakdown site', address: `Breakdown of ${br.vehicle}`, city: 'Breakdown site', service: [], handling: [], equipment: [], depotKm: 0, hist: {} };
          for (const id of onBoardDrops) { P.tasks[id] = Object.assign({}, P.tasks[id], { pairedWith: rescueId }); }
          const running = others.filter((r) => r.state.started).map((r) => ({ r, d: roadKm(r.state.atDepot ? P.depot : r.state, site) })).sort((a, b) => a.d - b.d).slice(0, 8);
          const idle = others.filter((r) => !r.state.started && !r.seq.length && (r.cls === br.cls || r.cls === 'TRACTOR_53')).sort((a, b) => (a.cls === br.cls ? 0 : 1) - (b.cls === br.cls ? 0 : 1)).slice(0, 2)
            .map((r) => { r.state.time = Math.max(r.state.time, t + 20); return { r, d: roadKm(P.depot, site), idle: true }; });
          for (const c of running.concat(idle)) {
            const trial = c.r.seq.slice();
            const seq = [rescueId].concat(onBoardDrops, trial);
            const sim = simulate(P, c.r, seq, { softAppointments: true });
            if (sim.viol.some((v) => ['overweight', 'overspots', 'hos_drive', 'hos_duty', 'equipment'].includes(v.type))) continue;
            c.r.seq = seq; c.r.sim = sim; c.r.softAppointments = true;
            rescue = c.r;
            actions.push(c.idle
              ? `Dispatch idle unit ${c.r.vehicle} with ${c.r.driverName} from Scarborough at ${hhmm(t + 20)} (${r1(c.d)} km), transload ${Math.round(w).toLocaleString()} lb, deliver the ${onBoardDrops.length} on-board drops`
              : `${c.r.id} (${c.r.driverName}) diverts ${r1(c.d)} km to the breakdown site, transloads ${Math.round(w).toLocaleString()} lb, delivers ${onBoardDrops.length} drops first`);
            break;
          }
          for (const id of onBoardDrops) units.splice(units.indexOf(P.unitOf[id]), 1);
          if (!rescue) {
            P.tasks[rescueId].allowed = [];
            actions.push('No route can absorb the on-board freight — see partner option');
          }
        }
        const remaining = units.filter(Boolean);
        const before = new Map(others.map((r) => [r.id, r.seq.length]));
        const failed = regretInsert(P, others, remaining, { softAppointments: false });
        const failed2 = retrySoftNoLog(P, others, failed);
        const partner = base.partner.slice();
        for (const u of failed2) partner.push({ unit: u.id, tasks: u.tasks, quote: u.tasks.reduce((a, id) => a + partnerQuote(P.tasks[id], P.depot), 0), reason: 'No in-house capacity after the disruption.' });
        const touched = others.filter((r) => r.seq.length !== before.get(r.id) || r === rescue).map((r) => r.id);
        const spread = touched.filter((id) => !rescue || id !== rescue.id || remaining.some((u) => rescue.seq.includes(u.tasks[0])));
        if (remaining.length - failed2.length > 0) actions.push(`Re-insert ${remaining.length - failed2.length} pending shipment(s) into ${spread.length} route(s): ${spread.slice(0, 6).join(', ')}${spread.length > 6 ? '…' : ''}`);
        if (failed2.length) actions.push(`${failed2.length} shipment(s) tendered to partner carrier`);
        mk('A', rescue ? 'Rescue on-board freight + redistribute' : 'Redistribute across the fleet', rs, partner, actions,
          'Uses spare capacity and hours on routes already on the road. No call-in cost; each stop goes to the route with the lowest marginal cost that still meets capacity, HOS and appointment windows.',
          { touchedRoutes: touched, rescueRoute: rescue && rescue.id });
      }
      // ---- Option B: spare driver / spare unit
      {
        const rs = freshRoutes();
        const br = rs.find((r) => r.id === rid);
        const spareDrv = (day.spareDrivers || []).find((d) => VEHICLES[br.cls].licence.includes(d.licence) || d.licence === 'AZ');
        const spareVeh = (day.spareVehicles || []).find((v) => (br.cls === 'TRACTOR_53' ? v.startsWith('Tractor') : v.startsWith('Truck'))) || (day.spareVehicles || [])[0];
        const actions = [];
        let callIn = 150;
        if (event.type === 'driver_absent') {
          br.driver = spareDrv ? spareDrv.code : 'SPARE'; br.driverName = spareDrv ? spareDrv.name : 'On-call driver';
          br.state.time = Math.max(br.state.time, t + 75); br.state.started = false; br.state.dutyStart = null;
          actions.push(`Call in ${br.driverName} (${spareDrv ? spareDrv.licence : 'DZ'}) — on site by ${hhmm(t + 45)}, departs ${hhmm(t + 75)}`);
          actions.push(`Keeps the original stop sequence on ${br.vehicle}`);
        } else {
          const site = { lat: br.state.lat || P.depot.lat, lng: br.state.lng || P.depot.lng };
          const d = roadKm(P.depot, site);
          const arrive = t + 30 + travelMin(d);
          br.state.time = arrive + 30; br.vehicle = (spareVeh || 'Spare unit') + ' (swap)';
          br.state.km += d; br.state.drive += travelMin(d) * 0; // shunt driven by the spare driver
          callIn += Math.round(d * VEHICLES[br.cls].costKm + (travelMin(d) * 2 / 60 + 1) * WAGE);
          actions.push(`Shunt ${spareVeh || 'a spare unit'} from Scarborough with ${spareDrv ? spareDrv.name : 'yard driver'} — ${r1(d)} km, on site ${hhmm(arrive)}`);
          actions.push(`Transload ${br.state.loadW.toLocaleString()} lb (30 min), ${br.driverName} continues the same sequence`);
          actions.push('Broken unit towed to shop; maintenance ticket raised');
        }
        evalRoute(P, br);
        if (!br.sim.feasible) { br.softAppointments = true; evalRoute(P, br); }
        const partner = base.partner.slice();
        mk('B', event.type === 'driver_absent' ? 'Call in a spare driver' : 'Swap in a spare truck', rs, partner, actions,
          event.type === 'driver_absent' ? 'Least disruption to other drivers: the absent driver\'s plan runs as-is, 75 min later. Costs a call-in premium.' : 'Freight stays with its driver; customers see one delay instead of the whole fleet being re-planned. Costs a shunt trip.',
          { callInCost: callIn });
        options_[options_.length - 1].kpis.totalCost += callIn;
        options_[options_.length - 1].delta.cost += callIn;
        options_[options_.length - 1].score += callIn;
      }
      // ---- Option C: partner carrier for everything pending
      {
        const rs = freshRoutes();
        const br = rs.find((r) => r.id === rid);
        const units = [...new Set(br.seq.filter((x) => typeof x === 'string').map((id) => P.unitOf[id]))];
        br.seq = []; br.broken = true; evalRoute(P, br);
        const partner = base.partner.slice();
        let q = 0;
        for (const u of units) { const quote = u.tasks.reduce((a, id) => a + partnerQuote(P.tasks[id], P.depot), 0); q += quote; partner.push({ unit: u.id, tasks: u.tasks, quote, reason: 'Disruption recovery' }); }
        mk('C', 'Tender pending stops to a partner carrier', rs, partner, [`Tender ${units.length} shipment(s) to partner carrier — est. $${q.toLocaleString()}`, event.type === 'breakdown' ? 'Partner collects on-board freight at the breakdown site (+ recovery fee)' : 'Partner collects from the Scarborough terminal'],
          'Protects every other route\'s plan. Most expensive and delivery times depend on the partner (assume +3 h).', {});
        const o = options_[options_.length - 1];
        o.delta.lateStops += units.length; o.score += units.length * 150;
      }
    } else if (event.type === 'hot_order') {
      const [p, d] = hotSrc || [];
      const id = 'HOT-1';
      const src = p ? P.tasks[p] : null;
      const pick = Object.assign({}, src || {}, { id: id + 'P', kind: 'P', release: t, earliest: t, latest: t + 120, hardLatest: null, pairedWith: id + 'D', orders: ['HOT-' + (src ? src.orders[0] : 'NEW')], issues: [], estimated: [] });
      const dsrc = d ? P.tasks[d] : null;
      const drop = Object.assign({}, dsrc || src || {}, { id: id + 'D', kind: 'D', earliest: t, latest: event.deadline || t + 240, hardLatest: event.deadline || null, pairedWith: id + 'P', orders: ['HOT-' + (dsrc ? dsrc.orders[0] : 'NEW')], issues: [], estimated: [] });
      if (event.weight) { pick.weight = pick.pickW = drop.weight = drop.dropW = event.weight; }
      pick.pickW = pick.pickW || pick.weight; pick.dropW = 0; drop.dropW = drop.dropW || drop.weight; drop.pickW = 0;
      pick.pickSp = pick.pickSp || pick.spots || 1; pick.dropSp = 0; drop.dropSp = drop.dropSp || drop.spots || 1; drop.pickSp = 0;
      pick.allowed = drop.allowed = (src && src.allowed) || ['STRAIGHT_26', 'TRACTOR_53', 'CARGO_VAN'];
      P.tasks[pick.id] = pick; P.tasks[drop.id] = drop;
      const unit = { id: 'UHOT', tasks: [pick.id, drop.id], release: t, allowed: pick.allowed, weight: pick.weight };
      P.unitOf[pick.id] = P.unitOf[drop.id] = unit;
      // the original legs of this order are not part of the base plan for this what-if
      const baseRoutes = freshRoutes();
      let idleSeen = false;
      const cands = baseRoutes.map((r, i) => ({ i, x: bestInsertion(P, r, unit) })).filter((c) => c.x).sort((a, b) => a.x.delta - b.x.delta)
        .filter((c) => { const idle = !baseRoutes[c.i].seq.some((x) => typeof x === 'string') && !baseRoutes[c.i].done.length; if (idle && idleSeen) return false; idleSeen = idleSeen || idle; return true; }).slice(0, 3);
      const letters = ['A', 'B', 'C'];
      cands.forEach((c, k) => {
        const rs = cloneRoutes(baseRoutes);
        const r = rs[c.i];
        r.seq = c.x.seq; evalRoute(P, r);
        r.insertedLive[pick.id] = t; r.insertedLive[drop.id] = t;
        const ps = r.sim.stops.find((s) => s.id === pick.id), ds = r.sim.stops.find((s) => s.id === drop.id);
        mk(letters[k], `Insert into ${r.id} (${r.driverName})`, rs, base.partner.slice(), [
          `Pick up at ${pick.city || pick.address} ${hhmm(ps.arr)}, deliver ${drop.city || drop.address} ${hhmm(ds.arr)}`,
          `+${r1(c.x.sim.km - (baseRoutes[c.i].sim ? baseRoutes[c.i].sim.km : 0))} km detour, route ends ${hhmm(r.sim.end)}`,
          `Peak load ${Math.round((r.sim.maxW / VEHICLES[r.cls].maxLb) * 100)}% · ${r1(r.sim.onDuty / 60)} h on duty`,
        ], explainInsert(P, unit, r, c.x), { route: r.id });
      });
      {
        const rs = cloneRoutes(baseRoutes);
        const quote = partnerQuote(pick, P.depot) + 90;
        mk(letters[cands.length] || 'D', 'Same-day partner courier', rs, base.partner.concat([{ unit: 'UHOT', tasks: [pick.id, drop.id], quote, reason: 'Hot shipment' }]), [`Book a partner courier — est. $${quote}`, 'No change to any route'], 'Fallback when no route has the hours or space; keeps the fleet plan untouched.', {});
      }
    } else if (event.type === 'failed_delivery') {
      const tid = event.task;
      const rs0 = freshRoutes();
      const owner = rs0.find((r) => r.done.some((s) => s.id === tid) || r.seq.includes(tid));
      const tt = P.tasks[tid];
      const retry = Object.assign({}, tt, { id: tid + '-R', kind: 'P', pickW: 0, pickSp: 0, earliest: t + 120, latest: 19 * 60, hardLatest: null, orders: tt.orders.map((o) => o + '-retry'), allowed: [owner ? owner.cls : 'STRAIGHT_26'] });
      // A: re-attempt later on the same truck (freight is still on board)
      {
        const rs = cloneRoutes(rs0);
        const r = rs.find((x) => x.id === owner.id);
        P.tasks[retry.id] = Object.assign({}, retry, { kind: 'P', pickW: 0, dropW: 0, weight: 0 });
        P.unitOf[retry.id] = { id: 'U' + retry.id, tasks: [retry.id], release: t + 120, allowed: retry.allowed, weight: 0 };
        const ins = bestInsertion(P, r, P.unitOf[retry.id]);
        if (ins) { applyInsertion(P, r, ins); r.insertedLive[retry.id] = t; }
        const st = ins && ins.sim.stops.find((s) => s.id === retry.id);
        mk('A', 'Re-attempt later today, same truck', rs, base.partner.slice(), ins ? [`Call receiver to confirm they reopen; re-attempt ${hhmm(st.start)}`, `Freight stays on ${r.vehicle}; ${r.id} ends ${hhmm(ins.sim.end)}`] : ['Not feasible within HOS'], 'Freight is already on the truck; a second attempt avoids another handling at the terminal.', { feasibleRetry: !!ins });
        if (!ins) options_[options_.length - 1].score += 1e5;
      }
      // B: return to terminal, redeliver next business day
      {
        const rs = cloneRoutes(rs0);
        const redeliver = 45 + Math.round(tt.depotKm * 2 * 0.95 * 0.25);
        mk('B', 'Return to terminal, redeliver next day', rs, base.partner.slice(), ['Driver keeps the freight; unloads at Scarborough at end of shift', `Auto-create a redelivery order for tomorrow's first wave (re-handling + share of route ≈ $${redeliver})`, 'Notify customer service with the failed-attempt photo / time'], 'Cheapest today; costs one day of transit and a re-handling at the dock.', {});
        const o = options_[options_.length - 1]; o.delta.lateStops += 1; o.delta.cost += redeliver; o.kpis.totalCost += redeliver; o.score += 150 + redeliver;
      }
      // C: owner drops the freight at the terminal, another route takes it out on its next reload
      {
        const rs = cloneRoutes(rs0);
        const ownerEnd = (rs.find((x) => x.id === owner.id).sim || {}).end || t + 120;
        const hid = tid + '-H';
        P.tasks[hid] = Object.assign({}, tt, { id: hid, kind: 'D', pairedWith: null, release: ownerEnd, earliest: Math.max(ownerEnd, t + 60), latest: 19 * 60, hardLatest: null, orders: tt.orders.map((o) => o + '-handoff'), dropW: tt.dropW || tt.weight, dropSp: tt.dropSp || tt.spots, pickW: 0, pickSp: 0 });
        const hu = { id: 'U' + hid, tasks: [hid], release: ownerEnd, allowed: tt.allowed, weight: tt.weight };
        P.unitOf[hid] = hu;
        const c = rs.filter((r) => r.id !== owner.id).map((r) => ({ r, x: bestInsertion(P, r, hu) })).filter((c) => c.x).sort((a, b) => a.x.delta - b.x.delta)[0];
        if (c) { applyInsertion(P, c.r, c.x); c.r.insertedLive[hid] = t; }
        const st = c && c.x.sim.stops.find((s) => s.id === hid);
        mk('C', 'Hand to another route via the terminal', rs, base.partner.slice(), c ? [`${owner.driverName} drops the freight at Scarborough (${hhmm(ownerEnd)})`, `${c.r.id} (${c.r.driverName}) reloads it and delivers ${hhmm(st.start)}`, `+${r1(c.x.sim.km - (c.r.sim ? 0 : 0) - (rs0.find((x) => x.id === c.r.id).sim || { km: 0 }).km)} km on ${c.r.id}`] : ['No route can reload and deliver it today'], 'Same-day recovery when the original driver is out of hours or far away.', { route: c && c.r.id });
        if (!c) options_[options_.length - 1].score += 1e5;
      }
    }

    options_.sort((a, b) => a.score - b.score);
    const best = options_[0];
    const rationale = options_.length > 1
      ? `${best.title} is recommended: ${best.delta.cost >= 0 ? '+' : ''}$${Math.round(best.delta.cost).toLocaleString()} vs plan and ${Math.max(0, best.delta.lateStops)} extra late stop(s), compared with ${options_.slice(1).map((o) => `${o.id} (${o.delta.cost >= 0 ? '+' : ''}$${Math.round(o.delta.cost).toLocaleString()}, ${Math.max(0, o.delta.lateStops)} late)`).join(' and ')}.`
      : 'Only one feasible option.';
    return { event: Object.assign({}, event, { timeLabel: hhmm(t) }), recommended: best.id, rationale, options: options_, baseKpis: baseK };
  }

  function retrySoftNoLog(P, routes, failed) {
    const out = [];
    for (const u of failed) {
      const c = routes.map((r) => ({ r, x: bestInsertion(P, r, u, { softAppointments: true }) })).filter((c) => c.x).sort((a, b) => a.x.delta - b.x.delta);
      if (c.length) { c[0].r.softAppointments = true; applyInsertion(P, c[0].r, c[0].x); } else out.push(u);
    }
    return out;
  }

  // ------------------------------------------------------------------ exports for integrations
  function toDispatchRows(plan) {
    const rows = [];
    const P = plan._P;
    for (const r of plan.routes) {
      let n = 0;
      for (const s of r.stops) {
        if (s.depot) { rows.push({ route: r.id, driver_code: r.driver, driver: r.driverName, vehicle: r.vehicle, seq: ++n, action: 'TERMINAL', ordno: '', customer: 'Scarborough terminal', address: '2215 Markham Rd, Scarborough ON', eta: hhmm(s.arr), etd: hhmm(s.dep), weight_lb: '', skid_spots: '', load_order: '', flags: 'reload' }); continue; }
        const t = P.tasks[s.id];
        const li = r.loadPlan && r.loadPlan.items.find((i) => i.id === s.id);
        rows.push({
          route: r.id, driver_code: r.driver, driver: r.driverName, vehicle: r.vehicle, seq: ++n,
          action: t.kind === 'P' ? 'PICKUP' : t.kind === 'D' ? 'DELIVERY' : 'MULTI', ordno: (t.orders || []).join(' '),
          customer: t.customer, address: t.address, eta: hhmm(s.arr), etd: hhmm(s.dep),
          weight_lb: t.weight, skid_spots: t.spots, load_order: li ? li.loadOrder : '',
          flags: [].concat(t.dg ? ['DG'] : [], t.hardLatest != null ? ['APPT ' + hhmm(t.appt)] : [], s.live != null ? ['LIVE ' + hhmm(s.live)] : [], t.estimated.length ? ['EST:' + t.estimated.join('/')] : []).join(' '),
        });
      }
    }
    for (const p of plan.partner) for (const id of p.tasks) {
      const t = P.tasks[id];
      rows.push({ route: 'PARTNER', driver_code: '', driver: 'Partner carrier', vehicle: '', seq: '', action: t.kind === 'P' ? 'PICKUP' : 'DELIVERY', ordno: (t.orders || []).join(' '), customer: t.customer, address: t.address, eta: '', etd: '', weight_lb: t.weight, skid_spots: t.spots, load_order: '', flags: `quote $${p.quote}` });
    }
    return rows;
  }

  function toCSV(rows) {
    if (!rows.length) return '';
    const cols = Object.keys(rows[0]);
    const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    return [cols.join(',')].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(','))).join('\n');
  }

  function publicPlan(plan) {
    const out = {};
    for (const k of Object.keys(plan)) if (!k.startsWith('_')) out[k] = plan[k];
    return out;
  }

  return { VEHICLES, ASSUMPTIONS, OBJECTIVES, DEFAULT_SETTINGS, buildCustomPlan, moveStop, planDay, manualPlan, detectConflicts, disrupt, scenarioCatalog, toDispatchRows, toCSV, publicPlan, hhmm, partnerQuote };
});
