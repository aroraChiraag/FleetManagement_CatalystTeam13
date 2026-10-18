/* Dispatch Copilot — front end (vanilla JS + Leaflet). Talks to the REST API; falls back to the in-browser engine. */
(function () {
  'use strict';

  const API_KEY = 'toe-demo-2026';
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d) => (n == null || isNaN(n) ? '—' : Number(n).toLocaleString('en-CA', { maximumFractionDigits: d || 0, minimumFractionDigits: d || 0 }));
  const money = (n) => (n == null ? '—' : (n < 0 ? '−$' : '$') + fmt(Math.abs(n)));
  const hhmm = (m) => (window.CopilotEngine ? window.CopilotEngine.hhmm(m) : m);
  const routeColor = (i) => `hsl(${(i * 137.508 + 225) % 360}, 72%, ${i % 2 ? 42 : 50}%)`;
  const ICON = {
    truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M1 3h15v13H1zM16 8h4l3 3v5h-7z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
    wrench: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/></svg>',
    'user-x': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M17 8l5 5M22 8l-5 5"/></svg>',
    zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9z"/></svg>',
    'x-circle': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  };

  // the two systems Trans Ontario runs today, explained wherever they are named
  const ELITE = '<span class="sys" tabindex="0" title="Elite TMS: Trans Ontario\u2019s transportation management system. Orders are booked here and the dispatcher assigns every pickup and delivery to a driver.">Elite TMS</span>';
  const SAMSARA = '<span class="sys" tabindex="0" title="Samsara: the fleet telematics platform in every truck. GPS tracking, the driver app that shows each route, and the electronic logbook (ELD) for hours of service.">Samsara</span>';

  // ------------------------------------------------------------------ data access (server API, else in-browser engine)
  const Data = {
    mode: 'api',
    local: null,
    async init() {
      try {
        const r = await fetch('api/v1/health', { cache: 'no-store' });
        if (!r.ok) throw new Error('no api');
        this.health = await r.json();
        this.mode = 'api';
      } catch (e) {
        this.mode = 'local';
        const ds = await (await fetch('data/dataset.json')).json();
        const E = window.CopilotEngine;
        const memo = {};
        const m = (k, f) => (memo[k] = memo[k] || f());
        const ev = () => !!(Data.local && Data.local.ev);
        const plan = (d) => m('p' + d + (ev() ? 'e' : ''), () => E.planDay(ds.days[d], { dynamic: true, settings: ev() ? { events: 'on' } : undefined }));
        const manual = (d) => m('m' + d + (ev() ? 'e' : ''), () => E.manualPlan(ds.days[d], { events: ev() ? 'on' : 'off' }));
        this.local = { ds, E, plan, manual, m, recipes: [], custom: {}, reports: {}, reportSeq: 0 };
        const dates = Object.keys(ds.days).sort();
        this.health = { dates, defaultDate: dates.includes('2026-09-22') ? '2026-09-22' : dates[0], dataset: ds.meta };
      }
      return this.health;
    },
    async get(path) {
      if (this.mode === 'api') {
        const r = await fetch('api/v1/' + withEvents(path), { headers: { 'X-API-Key': API_KEY } }).catch(() => { Health.fail(); throw new Error('The server is not responding. Check the terminal window running node server.js.'); });
        if (r.status >= 500) Health.fail();
        if (!r.ok) throw new Error((await r.json()).error || r.statusText);
        return r.json();
      }
      return this.localGet(path);
    },
    async del(path) {
      if (this.mode === 'api') {
        const r = await fetch('api/v1/' + path, { method: 'DELETE', headers: { 'X-API-Key': API_KEY } });
        if (!r.ok) throw new Error((await r.json()).error || r.statusText);
        return r.json();
      }
      const id = path.split('/')[2];
      if (path.startsWith('reports/')) { const d = path.split('/')[1]; this.local.reports[d] = (this.local.reports[d] || []).filter((x) => x.id !== id); return { deleted: id }; }
      this.local.recipes = this.local.recipes.filter((x) => x.id !== id);
      delete this.local.custom[id];
      return { deleted: id };
    },
    async post(path, body) {
      if (this.mode === 'api') {
        const r = await fetch('api/v1/' + withEvents(path), { method: 'POST', headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => { Health.fail(); throw new Error('The server is not responding. Check the terminal window running node server.js.'); });
        if (r.status >= 500) Health.fail();
        if (!r.ok) throw new Error((await r.json()).error || r.statusText);
        return r.json();
      }
      this.local.ev = S.events;
      const { ds, E, plan } = this.local;
      const d = path.split('/')[1];
      if (path.startsWith('plans/')) return this.localPlans('POST', path.split('?')[0], body);
      if (path.startsWith('reports/')) {
        const r = Object.assign({ id: 'RPT-' + String(++this.local.reportSeq).padStart(3, '0'), date: d, createdAt: new Date().toISOString() }, E.driverReport(ds.days[d], plan(d), body));
        (this.local.reports[d] = this.local.reports[d] || []).unshift(r);
        return r;
      }
      const preset = E.scenarioCatalog(plan(d), ds.days[d]).find((s) => s.type === body.type) || {};
      return Object.assign({ date: d }, E.disrupt(ds.days[d], Object.assign({}, preset, body), { basePlan: plan(d) }));
    },
    localPlans(method, path, body) {
      const { ds, E, plan, manual, recipes, custom } = this.local;
      const [, d, id, action] = path.split('/');
      const pub = (pid) => Object.assign(E.publicPlan(pid === 'copilot' ? plan(d) : pid === 'manual' ? manual(d) : custom[pid]), { planId: pid });
      if (method === 'GET' && !id) {
        const meta = (pid) => { const p = pid === 'copilot' ? plan(d) : pid === 'manual' ? manual(d) : custom[pid]; const r = recipes.find((x) => x.id === pid); return { id: pid, kpis: p.kpis, fleet: p.fleet, kind: r ? 'custom' : 'default', name: r ? r.name : pid === 'copilot' ? 'Copilot plan' : 'As dispatched', description: pid === 'copilot' ? 'Lowest total cost, live replay of call-ins, whole fleet available.' : pid === 'manual' ? 'What George actually did, rebuilt from GPS and re-costed with the same model.' : '', base: r && r.base, objective: p.custom && p.custom.objective, moves: r ? r.moves.length : 0 }; };
        return { date: d, plans: ['copilot', 'manual'].concat(recipes.filter((r) => r.date === d).map((r) => r.id)).map(meta) };
      }
      if (method === 'GET') return pub(id);
      if (method === 'POST' && !id) {
        const base = ['optimise', 'copilot', 'manual'].includes(body.base) ? body.base : 'optimise';
        const r = { id: 'c' + Date.now().toString(36), date: d, name: body.name || 'Custom plan', base, settings: base === 'optimise' ? body.settings || {} : {}, moves: [] };
        recipes.push(r);
        custom[r.id] = E.buildCustomPlan(ds.days[d], r);
        return pub(r.id);
      }
      const r = recipes.find((x) => x.id === id);
      if (action === 'moves') { const res = E.moveStop(custom[id], body.task, body.target); custom[id] = res.plan; r.moves.push({ task: body.task, target: body.target }); return { impact: res.impact, plan: pub(id) }; }
      if (action === 'undo') { r.moves.pop(); custom[id] = E.buildCustomPlan(ds.days[d], r); return pub(id); }
      throw new Error('unsupported offline: ' + path);
    },
    localGet(path) {
      this.local.ev = S.events && !path.startsWith('summary');
      if (path.startsWith('events/')) return { date: path.split('/')[1], simulated: true, events: this.local.E.eventsForDay(path.split('/')[1]) };
      const { ds, E, plan, manual, m } = this.local;
      if (path.startsWith('plans/')) return this.localPlans('GET', path.split('?')[0]);
      if (path.startsWith('fleet/')) { const d = path.split('/')[1]; return { date: d, drivers: ds.days[d].drivers.map((x) => ({ code: x.code, name: x.name, vehicle: x.vehicle, vehicleClass: x.vehicleClass, vehicleLabel: E.VEHICLES[x.vehicleClass].label, licence: x.licence })), objectives: E.OBJECTIVES, defaults: E.DEFAULT_SETTINGS }; }
      const [p, q] = path.split('?');
      const parts = p.split('/');
      const qs = new URLSearchParams(q || '');
      const cmp = (d) => {
        const c = E.detectConflicts(plan(d), ds.days[d], 'copilot'), mc = E.detectConflicts(manual(d), ds.days[d], 'manual');
        const cnt = (l) => l.reduce((a, x) => ((a[x.severity] = (a[x.severity] || 0) + 1), a), { critical: 0, warning: 0, info: 0 });
        return { date: d, weekday: ds.days[d].weekday, copilot: plan(d).kpis, manual: manual(d).kpis, actual: ds.days[d].actualSummary, morning: plan(d).morningKpis, liveInsertions: plan(d).live.length, conflicts: { copilot: cnt(c), manual: cnt(mc) } };
      };
      if (parts[0] === 'reports') { const list = this.local.reports[parts[1]] || []; if (parts[2]) return list.find((x) => x.id === parts[2]); return { date: parts[1], reports: list.map(({ result, ...rest }) => rest) }; }
      if (parts[0] === 'assumptions') return { assumptions: E.ASSUMPTIONS, vehicles: E.VEHICLES };
      if (parts[0] === 'summary') return m('summary', () => localSummary(ds, cmp));
      const d = parts[1];
      if (parts[0] === 'plan' && parts[2] === 'manual') return E.publicPlan(manual(d));
      if (parts[0] === 'plan' && parts[2] === 'compare') return cmp(d);
      if (parts[0] === 'plan') return E.publicPlan(plan(d));
      if (parts[0] === 'conflicts') { const which = qs.get('plan') || 'copilot'; const pl = which === 'manual' ? manual(d) : which === 'copilot' ? plan(d) : this.local.custom[which]; const list = E.detectConflicts(pl, ds.days[d], which === 'manual' || which === 'copilot' ? which : 'custom'); return { date: d, plan: which, conflicts: list }; }
      if (parts[0] === 'scenarios') return { date: d, scenarios: E.scenarioCatalog(plan(d), ds.days[d]) };
      if (parts[0] === 'decisions') return { date: d, decisions: plan(d).decisions };
      throw new Error('unsupported offline: ' + path);
    },
  };
  function localSummary(ds, cmp) {
    const dates = Object.keys(ds.days).sort();
    const days = dates.map(cmp);
    const sum = (f) => days.reduce((a, d) => a + f(d), 0);
    const pct = (a, b) => Math.round(((a - b) / b) * 1000) / 10;
    const agg = (k) => ({ km: sum((d) => d[k].km), cost: sum((d) => d[k].totalCost), trucks: sum((d) => d[k].trucksUsed), late: sum((d) => d[k].lateStops), stops: sum((d) => d[k].stopsRouted), duty: sum((d) => d[k].dutyHours), co2: sum((d) => d[k].co2kg) });
    const c = agg('copilot'), mm = agg('manual');
    return {
      period: ds.meta.period, days: days.length, history: ds.history, copilot: c, manual: mm,
      deltas: { kmPct: pct(c.km, mm.km), costPct: pct(c.cost, mm.cost), trucksPct: pct(c.trucks, mm.trucks), dutyPct: pct(c.duty, mm.duty), onTimeCopilot: Math.round(((c.stops - c.late) / c.stops) * 1000) / 10, onTimeManual: Math.round(((mm.stops - mm.late) / mm.stops) * 1000) / 10, kmSaved: mm.km - c.km, costSaved: mm.cost - c.cost, co2Saved: mm.co2 - c.co2, logbookKm: sum((d) => (d.actual && d.actual.logbookKm) || 0), manualVsLogbookPct: pct(mm.km, sum((d) => (d.actual && d.actual.logbookKm) || 0)), copilotVsLogbookPct: pct(c.km, sum((d) => (d.actual && d.actual.logbookKm) || 0)), trucksFreedPerDay: Math.round(((mm.trucks - c.trucks) / days.length) * 10) / 10 },
      lateDispatchedPct: Math.round((sum((d) => d.actual.lateDispatched) / sum((d) => d.manual.stopsRouted)) * 100),
      perDay: days.map((d) => ({ date: d.date, weekday: d.weekday, copilot: d.copilot, manual: d.manual, actual: d.actual })),
    };
  }

  // ------------------------------------------------------------------ live API health (checked every 15 s)
  const Health = {
    up: true, timer: null,
    paint() {
      const st = $('#apiStatus'); if (!st) return;
      st.classList.toggle('local', Data.mode === 'local');
      st.classList.toggle('down', Data.mode === 'api' && !this.up);
      st.title = Data.mode === 'api' ? (this.up ? 'The server answered the last health check.' : 'The server did not answer. Retrying every 15 seconds.') : 'No server found, so the planner runs inside this browser.';
      st.querySelector('span').textContent = Data.mode === 'local' ? 'Offline: in-browser engine' : this.up ? 'API connected' : 'API not responding, retrying';
    },
    fail() {
      if (Data.mode !== 'api' || !this.up) return;
      this.up = false; this.paint();
      toast('<b>The API stopped responding.</b><br>Check the terminal window running <code>node server.js</code>. Retrying every 15 seconds.', 'bad');
    },
    ok() {
      if (this.up) return;
      this.up = true; this.paint(); S.cache = {};
      toast('<b>API connected again.</b> Reloading this page.', 'good'); route();
    },
    async check() {
      try {
        const r = await fetch('api/v1/health', { cache: 'no-store', signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined });
        const h = r.ok ? await r.json() : null;
        if (h && h.status === 'ok') this.ok(); else this.fail();
      } catch (e) { this.fail(); }
    },
    start() { if (Data.mode === 'api' && !this.timer) this.timer = setInterval(() => this.check(), 15000); },
  };

  // simulated road & weather events: one switch in the top bar, sent as ?events=1 on every call
  function withEvents(path) {
    if (!S.events || path.startsWith('summary') || path.startsWith('health')) return path;
    return path + (path.includes('?') ? '&' : '?') + 'events=1';
  }

  // ------------------------------------------------------------------ state
  const S = {
    date: null, dates: [], cache: {},
    selectedRoute: null, planView: 'copilot', replayT: null, playing: null,
    problemsView: 'manual', problemsFilter: 'All',
    scenario: null, disruption: null, selectedOption: null, applied: {}, events: false,
  };
  async function cached(key, fn) {
    if (S.events && !key.startsWith('cplan:') && key !== 'summary' && key !== 'assumptions') key += '|ev';
    if (!S.cache[key]) S.cache[key] = fn().catch((e) => { delete S.cache[key]; throw e; });
    return S.cache[key];
  }
  const getPlan = () => cached('plan:' + S.date, () => Data.get('plan/' + S.date));
  const getManual = () => cached('manual:' + S.date, () => Data.get('plan/' + S.date + '/manual'));
  const getCompare = () => cached('cmp:' + S.date, () => Data.get('plan/' + S.date + '/compare'));
  const getConflicts = (which) => cached(`conf:${which}:${S.date}`, () => Data.get(`conflicts/${S.date}?plan=${which}`));
  const getScenarios = () => cached('scen:' + S.date, () => Data.get('scenarios/' + S.date));
  const getSummary = () => cached('summary', () => Data.get('summary'));
  const getPlans = () => cached('plans:' + S.date, () => Data.get('plans/' + S.date));
  const getPlanById = (id) => cached('cplan:' + id, () => Data.get(`plans/${S.date}/${id}`));
  function invalidatePlans() { delete S.cache['plans:' + S.date]; delete S.cache['plans:' + S.date + '|ev']; Object.keys(S.cache).filter((k) => k.startsWith('conf:')).forEach((k) => { if (!/conf:(copilot|manual):/.test(k)) delete S.cache[k]; }); }
  function setPlanCache(id, plan) { S.cache['cplan:' + id] = Promise.resolve(plan); invalidatePlans(); }
  const getAssumptions = () => cached('assumptions', () => Data.get('assumptions'));

  // ------------------------------------------------------------------ router
  const views = { pitch: viewPitch, plan: viewPlan, problems: viewProblems, adapt: viewAdapt, driver: viewDriver, api: viewApi, assumptions: viewAssumptions };
  let renderToken = 0;
  async function route() {
    const name = (location.hash.replace(/^#\/?/, '').split('?')[0] || 'pitch');
    const v = views[name] ? name : 'pitch';
    $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === v));
    stopReplay();
    const token = ++renderToken;
    const main = $('#view');
    main.innerHTML = '<div class="loading"><span class="spinner"></span>Planning ' + esc(S.date) + '…</div>';
    try {
      const html = await views[v](token);
      if (token !== renderToken) return;
      if (typeof html === 'string') main.innerHTML = html;
      if (views[v].after) views[v].after();
      window.scrollTo(0, 0);
    } catch (e) {
      console.error(e);
      main.innerHTML = `<div class="card empty">Something went wrong: ${esc(e.message)}</div>`;
    }
  }

  // ------------------------------------------------------------------ shared bits
  function deltaChip(copilot, manual, lowerIsBetter, unit, digits) {
    if (copilot == null || manual == null || manual === 0) return '';
    const diff = copilot - manual;
    const pct = (diff / Math.abs(manual)) * 100;
    const good = lowerIsBetter ? diff < 0 : diff > 0;
    if (Math.abs(diff) < 1e-9) return '<span class="delta">=</span>';
    const txt = unit === 'pp' ? `${diff > 0 ? '+' : '−'}${fmt(Math.abs(diff), 1)} pts` : `${diff > 0 ? '+' : '−'}${fmt(Math.abs(pct), digits == null ? 0 : digits)}%`;
    return `<span class="delta ${good ? 'good' : 'bad'}">${txt}</span>`;
  }
  function kpiTiles(c, m, o) {
    o = o || {};
    const vl = o.vsLabel || 'as dispatched';
    const t = (label, value, unit, vs, chip) => `<div class="kpi"><div class="label">${label}</div><div class="value">${value}${unit ? `<small>${unit}</small>` : ''}</div><div class="vs">${vs} ${chip || ''}</div></div>`;
    const br = c.overloadedTrucks + c.equipmentMismatches, mbr = m.overloadedTrucks + m.equipmentMismatches;
    return `<div class="kpis">
      ${t('Fleet in service', fmt(c.trucksUsed), `/ ${c.trucksAvailable}`, `${esc(fleetLine(o.fleet)) || '—'}${c.trucksAvailable - c.trucksUsed > 0 ? ` · ${c.trucksAvailable - c.trucksUsed} on standby` : ''}`, '')}
      ${t('Floor space used', fmt(c.avgUtilSpots), '%', `${vl} ${fmt(m.avgUtilSpots)}%`, deltaChip(c.avgUtilSpots, m.avgUtilSpots, false, 'pp'))}
      ${t('Overloaded / wrong vehicle', fmt(br), '', `${vl} ${fmt(mbr)}`, br < mbr ? '<span class="delta good">✓</span>' : br > mbr ? '<span class="delta bad">!</span>' : '')}
      ${t('On time', fmt(c.onTimePct, 1), '%', `${vl} ${fmt(m.onTimePct, 1)}%`, deltaChip(c.onTimePct, m.onTimePct, false, 'pp'))}
      ${t('Appointments met', `${c.appointmentsMet}/${c.appointments}`, '', `${vl} ${m.appointmentsMet}/${m.appointments}`, '')}
      ${t('Day cost', money(c.totalCost), '', `${vl} ${money(m.totalCost)}`, deltaChip(c.totalCost, m.totalCost, true))}
      ${t('Distance', fmt(c.km), 'km', `${vl} ${fmt(m.km)}`, deltaChip(c.km, m.km, true))}
      ${t('Driver hours', fmt(c.dutyHours), 'h', `${vl} ${fmt(m.dutyHours)} h`, deltaChip(c.dutyHours, m.dutyHours, true))}
      ${t('Partner tenders', fmt(c.partnerShipments), '', `${money(c.partnerCost)} quoted`, '')}
    </div>`;
  }
  function bar(pct, label) {
    const cls = pct > 100 ? 'over' : pct > 90 ? 'hot' : '';
    return `<div>${label ? `<div class="barlabel"><span>${label}</span><span>${pct}%</span></div>` : ''}<div class="bar ${cls}" title="${pct}%"><i style="width:${Math.min(100, pct)}%"></i></div></div>`;
  }
  const kindLetter = (k) => (k === 'P' ? 'P' : k === 'M' ? 'M' : 'D');
  const taskMap = (plan) => Object.fromEntries(plan.tasks.map((t) => [t.id, t]));
  function flagsFor(t, s) {
    const f = [];
    if (s && s.edited) f.push('<span class="chip warn" title="Moved here by the dispatcher">EDITED</span>');
    if (s && s.live != null) f.push(`<span class="chip live" title="Called in at ${hhmm(s.live)} and inserted live">LIVE ${hhmm(s.live)}</span>`);
    if (t.hardLatest != null) f.push(`<span class="chip ${s && s.start > t.hardLatest ? 'crit' : 'grey'}">APPT ${hhmm(t.appt)}</span>`);
    if (t.dg) f.push('<span class="chip crit">DG</span>');
    if ((t.service || []).some((x) => /RUSH|SAME DAY|EXPEDITE/.test(x))) f.push('<span class="chip warn">RUSH</span>');
    if (s && s.late > 0) f.push(`<span class="chip crit">+${s.late} min</span>`);
    if (t.estimated && t.estimated.length) f.push(`<span class="chip est" title="Estimated: ${esc(t.estimated.join(', '))}">EST</span>`);
    (t.handling || []).filter((h) => /tailgate|inside|residential|helper/.test(h)).forEach((h) => f.push(`<span class="chip grey">${esc(h)}</span>`));
    return f.join('');
  }

  // ------------------------------------------------------------------ map
  let map = null, mapLayers = null;
  function ensureMap(el) {
    if (map) { map.remove(); map = null; }
    if (!window.L) { if (el) el.innerHTML = '<div class="card empty" style="height:100%;display:grid;place-items:center">Map unavailable: no internet connection to load map tiles. Plans, problems and recovery options still work.</div>'; return false; }
    map = L.map(el, { zoomControl: true, attributionControl: true, preferCanvas: true }).setView([43.75, -79.45], 9);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', className: 'muted-tiles' }).addTo(map);
    mapLayers = L.layerGroup().addTo(map);
    return map;
  }
  const DEPOT = { lat: 43.80800808529279, lng: -79.24190011829823 };
  function drawRoutes(plan, opts) {
    if (!map || !window.L) return;
    opts = opts || {};
    if (!map) return;
    mapLayers.clearLayers();
    (plan.events || []).forEach((e) => {
      mapLayers.addLayer(L.circle([e.lat, e.lng], { radius: e.radius * 1000, color: e.color, weight: 1.5, dashArray: e.known ? null : '6 5', fillColor: e.color, fillOpacity: 0.07 })
        .bindPopup(`<b>${esc(e.label)}: ${esc(e.title)}</b><br>${hhmm(e.from)}–${hhmm(e.to)} · ${e.known ? 'known in advance' : 'not known in advance'}<br>${esc(e.detail)}${e.impact ? `<br>Delayed ${e.impact.stops} stop(s) on ${e.impact.routes.length} truck(s), +${e.impact.minutes} min` : ''}<br><i>Simulated event</i>`));
    });
    const T = taskMap(plan);
    const t = opts.time;
    const bounds = [[DEPOT.lat, DEPOT.lng]];
    const only = opts.only && opts.only.size ? opts.only : null;
    plan.routes.forEach((r, i) => {
      if (!r.nStops) return;
      if (only && !only.has(r.id)) return;
      const color = opts.colorOf ? opts.colorOf(r, i) : routeColor(i);
      const sel = S.selectedRoute === r.id || (opts.highlight && opts.highlight.includes(r.id));
      const dim = (S.selectedRoute && !sel && !opts.highlight) || (opts.highlight && !opts.highlight.includes(r.id));
      const pts = [[DEPOT.lat, DEPOT.lng]];
      let truck = [DEPOT.lat, DEPOT.lng];
      for (const s of r.stops) {
        if (s.depot) { pts.push([DEPOT.lat, DEPOT.lng]); if (t != null && s.arr <= t) truck = [DEPOT.lat, DEPOT.lng]; continue; }
        const task = T[s.id];
        if (!task) continue;
        const known = t == null || s.live == null || s.live <= t;
        if (!known) continue;
        pts.push([task.lat, task.lng]);
        bounds.push([task.lat, task.lng]);
        const done = t != null && s.dep <= t;
        if (t != null && s.arr <= t) truck = [task.lat, task.lng];
        const live = s.live != null;
        const m = L.circleMarker([task.lat, task.lng], {
          radius: sel ? 6.5 : live ? 5.5 : 4.5, color: live ? '#7A3FF2' : color, weight: live ? 2.5 : 1.5,
          fillColor: done || t == null ? color : '#fff', fillOpacity: dim ? 0.25 : 0.95, opacity: dim ? 0.3 : 1,
        });
        m.bindPopup(`<b>${esc(r.id)} · ${esc(r.driverName)}</b><br>${task.kind === 'P' ? 'Pickup' : task.kind === 'M' ? 'Pickup + drop' : 'Delivery'} ${esc(task.orders.join(', '))}<br>${esc(task.customer || '')} · ${esc(task.city || '')}<br>ETA <b>${hhmm(s.arr)}</b>${task.hardLatest != null ? ` · appt ${hhmm(task.appt)}` : ''} · ${fmt(task.weight)} lb${live ? `<br><span style="color:#7A3FF2">Inserted live at ${hhmm(s.live)}</span>` : ''}`);
        m.on('click', () => { if (opts.onRoute) opts.onRoute(r.id); });
        mapLayers.addLayer(m);
      }
      pts.push([DEPOT.lat, DEPOT.lng]);
      const line = L.polyline(pts, { color, weight: sel ? 4.5 : 2.5, opacity: dim ? 0.12 : sel ? 0.95 : 0.6, dashArray: r.broken ? '6 6' : null });
      line.on('click', () => { if (opts.onRoute) opts.onRoute(r.id); });
      mapLayers.addLayer(line);
      if (t != null) {
        const ic = L.divIcon({ className: '', html: `<div class="truck-icon" style="width:24px;height:24px;color:${color}">${ICON.truck}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
        mapLayers.addLayer(L.marker(truck, { icon: ic, opacity: dim ? 0.3 : 1, zIndexOffset: 500 }).bindTooltip(`${r.id} ${r.driverName}`));
      }
    });
    (only ? [] : plan.partner || []).forEach((p) => p.tasks.forEach((id) => {
      const task = T[id];
      if (!task) return;
      mapLayers.addLayer(L.circleMarker([task.lat, task.lng], { radius: 5, color: '#030718', weight: 2, fillColor: '#F2F2F2', fillOpacity: 1, dashArray: '2 2' }).bindPopup(`<b>Partner carrier</b><br>${esc(task.orders.join(', '))} · ${esc(task.city || '')}<br>${esc(p.reason)}<br>Quote $${fmt(p.quote)}`));
    }));
    const depotIcon = L.divIcon({ className: '', html: '<div class="depot-icon" style="width:30px;height:30px">TO</div>', iconSize: [30, 30], iconAnchor: [15, 15] });
    mapLayers.addLayer(L.marker([DEPOT.lat, DEPOT.lng], { icon: depotIcon, zIndexOffset: 1000 }).bindPopup('<b>Scarborough terminal</b><br>2215 Markham Rd'));
    if (opts.fit !== false) {
      const sr = S.selectedRoute && plan.routes.find((r) => r.id === S.selectedRoute);
      if (only) {
        const b = plan.routes.filter((r) => only.has(r.id)).flatMap((r) => r.stops.filter((s) => !s.depot && T[s.id]).map((s) => [T[s.id].lat, T[s.id].lng])).concat([[DEPOT.lat, DEPOT.lng]]);
        map.fitBounds(b, { padding: [30, 30], maxZoom: 12 });
      } else if (sr) {
        const b = sr.stops.filter((s) => !s.depot && T[s.id]).map((s) => [T[s.id].lat, T[s.id].lng]).concat([[DEPOT.lat, DEPOT.lng]]);
        map.fitBounds(b, { padding: [30, 30], maxZoom: 12 });
      } else {
        const core = bounds.filter((b) => Math.abs(b[0] - DEPOT.lat) < 1.2 && Math.abs(b[1] - DEPOT.lng) < 1.6);
        map.fitBounds(core.length > 5 ? core : bounds, { padding: [20, 20] });
      }
    }
  }

  // ================================================================== PITCH
  async function viewPitch() {
    const sm = await getSummary();
    const d = sm.deltas, h = sm.history;
    const maxKm = Math.max(...sm.perDay.map((x) => Math.max(x.manual.km, x.copilot.km)));
    const maxCost = Math.max(...sm.perDay.map((x) => Math.max(x.manual.totalCost, x.copilot.totalCost)));
    const mixOf = (w, cls) => sm.fleetMix[w].find((r) => r.cls === cls) || { usedPerDay: 0, availablePerDay: 0, stopsPerTruck: 0, utilSpots: 0, utilLb: 0, small: 0, overloads: 0, mismatches: 0 };
    const T = { c: mixOf('copilot', 'TRACTOR_53'), m: mixOf('manual', 'TRACTOR_53') };
    const ST = { c: mixOf('copilot', 'STRAIGHT_26'), m: mixOf('manual', 'STRAIGHT_26') };
    const V = { c: mixOf('copilot', 'CARGO_VAN'), m: mixOf('manual', 'CARGO_VAN') };
    const standby = Math.round(sm.fleetMix.copilot.reduce((a, r) => a + r.availablePerDay - r.usedPerDay, 0));
    return `
    <section class="hero">
      <div style="position:relative;z-index:1">
        <div class="eyebrow">Catalyst Hackathon · Team #13 · for Trans Ontario Express</div>
        <h1>Smarter freight,<br><em>smarter routes.</em></h1>
        <p class="lead">Dispatch Copilot sits next to George, the dispatcher. It builds the day's plan from ${ELITE} orders, flags problems before trucks leave the yard, and re-plans in seconds when a truck breaks down or a rush order lands. It explains every decision.</p>
        <div class="cta">
          <a class="btn" href="#/plan">${ICON.play} Watch it plan a real day</a>
          <a class="btn ghost" href="#/adapt">Break a truck mid-route →</a>
        </div>
      </div>
      <div class="hero-stats">
        <div class="hs"><b>${d.utilSpotsCopilot}%</b><span>of truck floor space used vs ${d.utilSpotsManual}% as dispatched: every load matched to a 53′ trailer, straight truck or van</span></div>
        <div class="hs"><b>${fmt(Math.abs(d.kmPct), 0)}%</b><span>less distance driven (${fmt(d.kmSaved)} km over ${sm.days} days)${d.logbookKm ? `. Conservative: our estimate of George's plan is ${fmt(Math.abs(d.manualVsLogbookPct), 0)}% below the ${fmt(d.logbookKm)} km the trucks' logbooks recorded` : ''}</span></div>
        <div class="hs"><b>${fmt(d.onTimeCopilot, 1)}%</b><span>stops on time vs ${fmt(d.onTimeManual, 1)}% as dispatched</span></div>
        <div class="hs"><b>${money(d.costSaved)}</b><span>lower operating cost in ${sm.days} operating days (${fmt(Math.abs(d.costPct), 0)}%)</span></div>
        <div class="hs wide"><span>Measured on Trans Ontario's own 20 Sep – 3 Oct 2026 export: ${fmt(h.customer_stops)} customer stops replayed minute by minute, with every call-in pickup entering the plan at the real time George dispatched it in ${ELITE}.</span></div>
      </div>
    </section>

    <section class="section">
      <div class="eyebrow">The problem, in Trans Ontario's own data</div>
      <h2>George plans 250+ stops a day by hand, and the plan keeps moving</h2>
      <p class="lead">George works in two systems today:</p>
      <div class="grid g2" style="margin-bottom:16px">
        <div class="card sysbox"><div class="sys-ic">E</div><div><h3>Elite TMS: where orders live</h3><p class="small">Trans Ontario's <b>transportation management system</b>. Customer orders are booked here with shipper, receiver, pieces, weight, service level and appointment. Each order has a pickup leg and a delivery leg, and <b>George assigns every leg to a driver by hand</b>.</p></div></div>
        <div class="card sysbox"><div class="sys-ic">S</div><div><h3>Samsara: what happens on the road</h3><p class="small">The <b>fleet telematics platform</b> in every truck: GPS tracking, the driver app that shows each route and its stops, and the electronic logbook (ELD) that records driving hours. Elite assignments become Samsara routes automatically.</p></div></div>
      </div>
      <p class="lead">Elite records George's decisions and Samsara delivers them, but neither works out the best plan. In two weeks the Elite→Samsara integration logged:</p>
      <div class="grid g4">
        <div class="card stat-tile"><b>${sm.lateDispatchedPct}%</b><span>of stops were dispatched <b>after 07:00</b>, once trucks had already left the yard</span></div>
        <div class="card stat-tile"><b>${fmt(h.n_updates)}</b><span>route updates pushed to drivers (${fmt(h.n_updates / sm.days)} per day)</span></div>
        <div class="card stat-tile"><b>${fmt(h.n_x_cancels)}</b><span>cancellations applied to live routes</span></div>
        <div class="card stat-tile"><b>${fmt(h.n_appt_missed)}</b><span>appointment-missed warnings, plus ${fmt(h.n_appt_risk)} at-risk alerts</span></div>
      </div>
    </section>

    <section class="section">
      <div class="eyebrow">What it does</div>
      <h2>Three jobs, one connected plan</h2>
      <p class="lead">Vehicle assignment, loading order, routing and partner-carrier tenders are decided together. A change in one is checked against all the others.</p>
      <div class="grid g3">
        <div class="card pillar"><div class="n">1</div><h3>Plan the day</h3><p class="muted small">Regret-based insertion with capacity, equipment, licence, hours-of-service and appointment constraints, then local search.</p>
          <ul><li>Matches each load to the right vehicle type (53′ trailer, 26′ straight truck or van) and a driver licensed for it</li><li>Sequences stops (pickup always before its own delivery)</li><li>Builds a LIFO load plan for each truck</li><li>Tenders freight to a partner when it's cheaper or out of network</li></ul></div>
        <div class="card pillar"><div class="n">2</div><h3>Catch problems early</h3><p class="muted small">Runs the same checks on George's plan and on its own.</p>
          <ul><li>Overweight / out-of-space trucks</li><li>53′ freight on a straight truck, DG on a van</li><li>Appointments that can't be met</li><li>13 h driving / 14 h on-duty breaches</li><li>Missing weights, skids and appointment times, flagged <b>ESTIMATED</b></li></ul></div>
        <div class="card pillar"><div class="n">3</div><h3>Adapt in seconds</h3><p class="muted small">Freezes what has already happened and re-plans only what's left.</p>
          <ul><li>Breakdown: rescue the on-board freight, redistribute the rest</li><li>Driver sick: redistribute vs call in a spare</li><li>Rush order: top 3 insertions with ETA and detour</li><li>Failed delivery: retry, hand off, or redeliver tomorrow</li></ul></div>
      </div>
    </section>

    <section class="section">
      <div class="eyebrow">Proof</div>
      <h2>Ten real days: as dispatched vs copilot</h2>
      <p class="lead">Both plans are scored with the same distance, time and cost model, so the comparison is like for like. Pickups enter the copilot's plan only when George actually dispatched them in ${ELITE}.</p>
      <div class="card" style="margin-bottom:16px">
        <h3>Right truck, right load: how the fleet was used (average per day)</h3>
        <div class="grid g2" style="align-items:start">
          <table class="tbl mix"><thead><tr><th>Vehicle type</th><th>In service</th><th>Stops per unit</th><th>Floor used</th><th>Rule breaches</th></tr></thead><tbody>
            ${[['53′ trailer', T], ['26′ straight truck', ST], ['Cargo van', V]].map(([n, x]) => `<tr><td><b>${n}</b><div class="small muted">${fmt(x.c.availablePerDay, 0)} available</div></td><td class="num">${fmt(x.m.usedPerDay, 1)} → <b>${fmt(x.c.usedPerDay, 1)}</b></td><td class="num">${fmt(x.m.stopsPerTruck, 1)} → <b>${fmt(x.c.stopsPerTruck, 1)}</b></td><td class="num">${x.m.utilSpots}% → <b>${x.c.utilSpots}%</b></td><td class="num">${x.m.overloads + x.m.mismatches} → <b>${x.c.overloads + x.c.mismatches}</b></td></tr>`).join('')}
          </tbody></table>
          <div class="why-box"><b>Why fewer trucks are needed</b>
            <ol>
              <li><b>53′ trailers run full, multi-stop loads.</b> The trailer that carries a full-truckload or multi-skid order also takes nearby drops: ${fmt(T.c.stopsPerTruck, 1)} stops per trailer at ${T.c.utilSpots}% floor, vs ${fmt(T.m.stopsPerTruck, 1)} stops at ${T.m.utilSpots}% as dispatched.</li>
              <li><b>Straight trucks take the city multi-drop work</b> that needs a tailgate or residential access, loaded in delivery order to ${ST.c.utilSpots}% of the floor (vs ${ST.m.utilSpots}%).</li>
              <li><b>The van carries small rush parcels</b>, ${fmt(V.c.stopsPerTruck, 1)} a day at ${V.c.utilSpots}% of its space, instead of ${fmt(V.m.stopsPerTruck, 1)} at ${V.m.utilSpots}%.</li>
              <li><b>Nothing is overloaded or on the wrong vehicle.</b> As dispatched: ${d.overloadsManual} overloaded truck-days and ${d.mismatchesManual} loads on the wrong equipment. Copilot: ${d.overloadsCopilot + d.mismatchesCopilot}.</li>
            </ol>
            <p class="small">Result: the same freight fits on fewer units, so about <b>${standby} trucks and drivers a day stay on standby</b> for breakdowns, call-ins and peak days. If you'd rather keep everyone rolling, build a custom plan with <b>"Use the whole fleet"</b>.</p>
            <p class="small muted">As-dispatched loads are checked per ${SAMSARA} route; skid counts missing in Elite are estimated.</p>
          </div>
        </div>
      </div>
      <div class="grid g2">
        <div class="card"><h3>Day cost</h3><div class="legend" style="margin-bottom:10px"><span><i style="background:#B9BFCE"></i>As dispatched</span><span><i style="background:var(--blue)"></i>Copilot</span></div>
          <div class="daybars">${sm.perDay.map((x) => `<div class="daybar"><span>${x.weekday.slice(0, 3)} ${x.date.slice(5)}</span><div class="bars"><i class="m" style="width:${(x.manual.totalCost / maxCost) * 100}%"></i><i class="c" style="width:${(x.copilot.totalCost / maxCost) * 100}%"></i></div><span class="num">${money(x.manual.totalCost)} → <b>${money(x.copilot.totalCost)}</b></span></div>`).join('')}</div></div>
        <div class="card"><h3>Kilometres driven (modelled)</h3><div class="legend" style="margin-bottom:10px"><span><i style="background:#B9BFCE"></i>As dispatched</span><span><i style="background:var(--blue)"></i>Copilot</span></div>
          <div class="daybars">${sm.perDay.map((x) => `<div class="daybar"><span>${x.weekday.slice(0, 3)} ${x.date.slice(5)}</span><div class="bars"><i class="m" style="width:${(x.manual.km / maxKm) * 100}%"></i><i class="c" style="width:${(x.copilot.km / maxKm) * 100}%"></i></div><span class="num">${fmt(x.manual.km)} → <b>${fmt(x.copilot.km)}</b></span></div>`).join('')}</div></div>
      </div>
    </section>

    <section class="section">
      <div class="eyebrow">How it fits</div>
      <h2>No rip-and-replace: it plugs between the two systems George already uses</h2>
      <div class="flow" style="margin-top:12px">
        <div class="stack"><div class="box"><b>Elite TMS · order system</b><span class="muted small">Orders, pickup and delivery legs, service levels, appointments, weights and skids</span></div><div class="box"><b>Samsara · trucks on the road</b><span class="muted small">GPS arrivals, driving-hours logs, which truck each driver has</span></div></div>
        <div class="arrow">→</div>
        <div class="box core"><b>Dispatch Copilot</b><span class="muted small">Plan engine · conflict checks · disruption recovery · decision log. REST API + dispatcher console. George approves; the copilot recommends.</span></div>
        <div class="arrow">→</div>
        <div class="stack"><div class="box"><b>Samsara driver app</b><span class="muted small">Approved stop sequence and ETAs pushed to each driver</span></div><div class="box"><b>Partner carriers</b><span class="muted small">Tenders with quote and reason</span></div><div class="box"><b>Dock</b><span class="muted small">Load sheet in LIFO order</span></div></div>
      </div>
    </section>

    <section class="section">
      <div class="eyebrow">See it in action</div>
      <h2>Six-minute demo script</h2>
      <ol class="steps">
        <li><div><b>Plan Tuesday 22 Sep</b><span>Same freight, about half the trucks. Press play to replay the day and watch call-ins appear live at their real Elite dispatch times.</span></div><a class="btn sm" href="#/plan">Open</a></li>
        <li><div><b>Open a route</b><span>Stop timeline with ETAs and windows, the LIFO deck plan for the dock, and the reason behind every assignment.</span></div><a class="btn sm ghost" href="#/plan">Open</a></li>
        <li><div><b>Build your own plan</b><span>Pick what matters (cost, service, whole fleet, fewest km), choose drivers and trucks, set shift rules, or copy a plan and move stops by hand. Every option lands in a side-by-side comparison.</span></div><a class="btn sm ghost" href="#/plan">Open</a></li>
        <li><div><b>Compare problems</b><span>As dispatched: missed appointments, overloads, HOS breaches. Copilot plan: the same checks, mostly clean, with data gaps called out.</span></div><a class="btn sm ghost" href="#/problems">Open</a></li>
        <li><div><b>Break a truck mid-route</b><span>Three costed recovery options in under a second. Apply the recommended one and download the decision.</span></div><a class="btn sm ghost" href="#/adapt">Open</a></li>
        <li><div><b>Call the API</b><span>Every plan, conflict and decision is one HTTP call away, ready to push to Samsara or pull into Elite.</span></div><a class="btn sm ghost" href="#/api">Open</a></li>
      </ol>
    </section>

    <section class="section">
      <div class="eyebrow">Pilot proposal</div>
      <h2>From demo to dispatch floor in 8 weeks</h2>
      <div class="roadmap">
        <div class="card"><b>Weeks 1–2 · Shadow</b><p class="small" style="margin-top:6px">Copilot plans each morning from the live Elite feed; George dispatches as usual. We compare every evening.</p></div>
        <div class="card"><b>Weeks 3–4 · Assist</b><p class="small" style="margin-top:6px">George accepts or edits the plan. Problem alerts on, disruption options on demand.</p></div>
        <div class="card"><b>Weeks 5–6 · Integrate</b><p class="small" style="margin-top:6px">Push approved routes to Samsara via API; real road distances replace the model.</p></div>
        <div class="card"><b>Weeks 7–8 · Scale</b><p class="small" style="margin-top:6px">Partner-carrier tendering, dock load sheets, KPIs reviewed with ops leadership.</p></div>
      </div>
      <p class="muted small" style="margin-top:14px">Honest scope: distances are modelled (straight line × 1.3), vehicle payloads and driver licences are inferred, and customer names are pseudonymised. All assumptions are listed under <a href="#/assumptions">Data &amp; Assumptions</a>.</p>
    </section>`;
  }

  // ------------------------------------------------------------------ why a stop is late, and the simulated events
  const CAUSE_CLASS = { booking: 'warn', event: 'crit', sequence: 'grey', start: 'grey', tight: 'ok' };
  function whyBar(w) {
    const parts = [['driving', 'Driving', '#8EA3F5'], ['onSite', 'On site at earlier stops', '#030718'], ['reloads', 'Terminal reloads', '#8A90A2'], ['waiting', 'Waiting', '#D5D9E3'], ['events', 'Road & weather', '#C62828']].filter(([k]) => w.parts[k] > 0);
    const total = parts.reduce((a, [k]) => a + w.parts[k], 0) || 1;
    return `<div class="why-bar" title="From terminal departure ${hhmm(w.depart)} to arrival ${hhmm(w.arr)}">${parts.map(([k, l, c]) => `<i style="width:${(w.parts[k] / total) * 100}%;background:${c}" title="${l}: ${w.parts[k]} min"></i>`).join('')}</div>
      <div class="why-legend">${parts.map(([k, l, c]) => `<span><i style="background:${c}"></i>${l} ${fmt(w.parts[k])} min</span>`).join('')}</div>
      <div class="small muted">Left the terminal ${hhmm(w.depart)} · arrived ${hhmm(w.arr)} · ${w.deadlineKind === 'appointment' ? 'appointment latest' : 'promised by'} ${hhmm(w.deadline)}${w.cause !== 'tight' && w.directArr ? ` · as the first stop: ${hhmm(w.directArr)}` : ''}</div>`;
  }
  function whyBlock(w, open) {
    if (!w) return '';
    return `<div class="whybox"><div><span class="chip ${CAUSE_CLASS[w.cause] || 'grey'}">${esc(w.label)}</span> ${w.late ? `<b>${w.by} min late.</b> ` : ''}${esc(w.headline)}</div>
      <details class="why-more"${open ? ' open' : ''}><summary>How the time adds up</summary>${whyBar(w)}${w.reasons.length ? `<ul>${w.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</details></div>`;
  }
  function evChips(ev, events) {
    if (!ev || !ev.length) return '';
    return ev.map((h) => { const e = (events || []).find((x) => x.id === h.id) || {}; return `<span class="chip" style="background:${e.color || '#C62828'}18;color:${e.color || '#C62828'}" title="${esc(e.title || '')}">${esc(e.label || 'Event')} +${h.min} min</span>`; }).join('');
  }
  function eventsCard(plan) {
    if (!S.events) {
      return `<div class="card ev-off" style="margin-bottom:16px"><div class="row" style="justify-content:space-between"><div><b>Road &amp; weather events are off.</b> <span class="small muted">Turn them on to stress-test this day with simulated road closures, construction, weather, event traffic and accidents, and see which stops they make late.</span></div><button class="btn ghost sm" data-ev-toggle>Turn on simulated events</button></div></div>`;
    }
    const evs = plan.events || [];
    return `<div class="card" style="margin-bottom:16px">
      <div class="row" style="justify-content:space-between"><h3 style="margin:0">Road &amp; weather on ${esc(S.date)} <span class="chip est">Simulated</span></h3><span class="small muted">Known events are planned around; accidents are not known in advance.</span></div>
      <div style="overflow:auto;margin-top:8px"><table class="tbl"><thead><tr><th>Event</th><th>When</th><th>Known?</th><th>Effect on this plan</th></tr></thead><tbody>
      ${evs.map((e) => `<tr><td><span class="ev-dot" style="background:${e.color}"></span><b>${esc(e.label)}</b><div class="small muted">${esc(e.title)} · ${esc(e.detail)}</div></td><td class="num">${hhmm(e.from)}–${hhmm(e.to)}</td><td>${e.known ? '<span class="chip ok">In advance</span>' : '<span class="chip crit">Surprise</span>'}</td><td>${e.impact && e.impact.stops ? `<b>${e.impact.stops} stop${e.impact.stops === 1 ? '' : 's'}</b> on ${e.impact.routes.length} truck${e.impact.routes.length === 1 ? '' : 's'}, +${fmt(e.impact.minutes)} min<div class="small muted">${esc(e.impact.routes.slice(0, 8).join(', '))}</div>` : '<span class="muted">No truck affected</span>'}</td></tr>`).join('')}
      </tbody></table></div></div>`;
  }

  // ================================================================== PLAN
  const isDefaultPlan = (id) => id === 'copilot' || id === 'manual';
  async function loadPlanById(id) {
    if (id === 'copilot') return getPlan();
    if (id === 'manual') return getManual();
    return getPlanById(id);
  }
  const fleetLine = (fleet) => (fleet || []).filter((f) => f.used).map((f) => (f.cls === 'CARGO_VAN' ? `${f.used} van` : `${f.used} × ${f.cls === 'TRACTOR_53' ? '53′ trailer' : '26′ truck'}`)).join(' · ');

  function fleetWhy(shown, vs, vsLabel) {
    const by = (p, cls) => (p.fleet || []).find((f) => f.cls === cls) || { used: 0, available: 0, stopsPerTruck: 0, utilSpots: 0, small: 0, tractorOnly: 0, overloads: 0, mismatches: 0 };
    const k = shown.kpis, kv = vs.kpis;
    const T = [by(shown, 'TRACTOR_53'), by(vs, 'TRACTOR_53')], S2 = [by(shown, 'STRAIGHT_26'), by(vs, 'STRAIGHT_26')], V = [by(shown, 'CARGO_VAN'), by(vs, 'CARGO_VAN')];
    const items = [];
    if (T[0].used) items.push(`<li><b>53′ trailers:</b> ${T[0].used} in service, ${fmt(T[0].stopsPerTruck, 1)} stops each at ${T[0].utilSpots}% floor (${vsLabel}: ${T[1].used} trailers, ${fmt(T[1].stopsPerTruck, 1)} stops, ${T[1].utilSpots}%). They carry all ${T[0].tractorOnly} trailer-only loads and pick up ${T[0].small} small drops along the way.</li>`);
    if (S2[0].used) items.push(`<li><b>26′ straight trucks:</b> ${S2[0].used} in service, ${fmt(S2[0].stopsPerTruck, 1)} stops each at ${S2[0].utilSpots}% floor (${vsLabel}: ${S2[1].used}, ${fmt(S2[1].stopsPerTruck, 1)} stops, ${S2[1].utilSpots}%). City multi-drops, tailgate and residential work go here.</li>`);
    if (V[0].used) items.push(`<li><b>Van:</b> ${fmt(V[0].stopsPerTruck, 1)} small parcels at ${V[0].utilSpots}% of its space (${vsLabel}: ${fmt(V[1].stopsPerTruck, 1)} at ${V[1].utilSpots}%).</li>`);
    const breaches = k.overloadedTrucks + k.equipmentMismatches, vb = kv.overloadedTrucks + kv.equipmentMismatches;
    items.push(`<li><b>Load rules:</b> ${breaches} overloaded or wrong-vehicle trucks (${vsLabel}: ${vb}).</li>`);
    const standby = k.trucksAvailable - k.trucksUsed;
    const head = k.trucksUsed < kv.trucksUsed
      ? `Why ${k.trucksUsed} units carry what took ${kv.trucksUsed}`
      : k.trucksUsed > kv.trucksUsed ? `Why ${k.trucksUsed} units instead of ${kv.trucksUsed}` : `Fleet use`;
    const tail = standby > 0
      ? `<p class="small">${standby} trucks and drivers stay on standby for breakdowns, call-ins and tomorrow's overflow. To keep everyone rolling, build a plan with <b>"Use the whole fleet"</b>.</p>`
      : '<p class="small">Every available truck is in service.</p>';
    return `<div class="why-box"><b>${head}</b><ol>${items.join('')}</ol>${tail}</div>`;
  }

  function fleetMixCard(shown, vs, vsLabel) {
    const vsBy = Object.fromEntries((vs.fleet || []).map((f) => [f.cls, f]));
    return `<div class="card" style="margin-bottom:16px"><h3>Right truck, right load</h3>
      <div class="grid g2" style="align-items:start">
        <div style="overflow:auto"><table class="tbl mix"><thead><tr><th>Vehicle type</th><th>In service</th><th>Stops / unit</th><th>Floor used</th><th>Weight used</th><th>What it carried</th></tr></thead><tbody>
        ${(shown.fleet || []).map((f) => { const m = vsBy[f.cls] || {}; return `<tr><td><b>${esc(f.label)}</b><div class="small muted">${fmt(f.maxLb)} lb · ${f.maxSpots} skid spots</div></td>
          <td class="num"><b>${f.used}</b> / ${f.available}<div class="small muted">${vsLabel} ${m.used ?? '—'}</div></td>
          <td class="num"><b>${fmt(f.stopsPerTruck, 1)}</b><div class="small muted">${fmt(m.stopsPerTruck, 1)}</div></td>
          <td>${bar(f.utilSpots)}<div class="small muted">${f.utilSpots}% · ${vsLabel} ${m.utilSpots ?? '—'}%</div></td>
          <td>${bar(f.utilLb)}<div class="small muted">${f.utilLb}% · ${vsLabel} ${m.utilLb ?? '—'}%</div></td>
          <td class="small" style="white-space:normal;min-width:160px">${[f.tractorOnly ? `${f.tractorOnly} trailer-only loads` : '', f.heavy ? `${f.heavy} heavy / multi-skid` : '', f.small ? `${f.small} small drops` : '', f.tailgate ? `${f.tailgate} tailgate / residential` : '', f.overloads + f.mismatches ? `<span class="chip crit">${f.overloads + f.mismatches} breaches</span>` : ''].filter(Boolean).join(' · ') || '—'}</td></tr>`; }).join('')}
        </tbody></table></div>
        ${fleetWhy(shown, vs, vsLabel)}
      </div></div>`;
  }

  function compareCard(plans, current) {
    const ps = plans.plans;
    const best = (f, low) => { const vals = ps.map((p) => f(p.kpis)); return low ? Math.min(...vals) : Math.max(...vals); };
    const bCost = best((k) => k.totalCost, true), bKm = best((k) => k.km, true), bOt = best((k) => k.onTimePct), bFloor = best((k) => k.avgUtilSpots);
    const mark = (v, b, txt) => (v === b ? `<b class="best">${txt}</b>` : txt);
    return `<div class="card" style="margin-bottom:16px"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Compare plans for ${esc(S.date)}</h3><span class="muted small">Green = best in column · click a row to open it</span></div>
      <div style="overflow:auto;margin-top:8px"><table class="tbl cmp"><thead><tr><th>Plan</th><th>Fleet in service</th><th>Floor used</th><th>km</th><th>On time</th><th>Appointments</th><th>Load breaches</th><th>Partner</th><th>Day cost</th></tr></thead><tbody>
      ${ps.map((p) => { const k = p.kpis; return `<tr class="click ${p.id === current ? 'on' : ''}" data-open-plan="${esc(p.id)}"><td style="min-width:190px"><b>${esc(p.name)}</b>${p.kind === 'custom' ? ` <span class="chip grey">custom</span>${p.moves ? ` <span class="chip warn">${p.moves} edit${p.moves > 1 ? 's' : ''}</span>` : ''}` : ''}<div class="small muted">${esc(p.kind === 'custom' ? (p.objective ? p.objective.label : '') + (p.base && p.base !== 'optimise' ? ` · copy of ${p.base === 'manual' ? 'as dispatched' : 'copilot'}` : '') : p.description || '')}</div></td>
        <td class="num" style="min-width:150px">${k.trucksUsed} / ${k.trucksAvailable}<div class="small muted">${esc(fleetLine(p.fleet))}</div></td><td class="num">${mark(k.avgUtilSpots, bFloor, k.avgUtilSpots + '%')}</td><td class="num">${mark(k.km, bKm, fmt(k.km))}</td><td class="num">${mark(k.onTimePct, bOt, fmt(k.onTimePct, 1) + '%')}</td><td class="num">${k.appointmentsMet}/${k.appointments}</td>
        <td class="num">${k.overloadedTrucks + k.equipmentMismatches ? `<span class="chip crit">${k.overloadedTrucks + k.equipmentMismatches}</span>` : '<span class="chip ok">0</span>'}</td><td class="num">${k.partnerShipments}</td><td class="num">${mark(k.totalCost, bCost, money(k.totalCost))}</td></tr>`; }).join('')}
      </tbody></table></div></div>`;
  }

  async function viewPlan(token) {
    const [plan, manual, cmp, plans] = await Promise.all([getPlan(), getManual(), getCompare(), getPlans()]);
    if (token !== renderToken) return;
    if (!plans.plans.some((p) => p.id === S.planView)) S.planView = 'copilot';
    const pv = S.planView;
    const isCustom = !isDefaultPlan(pv);
    const base = await loadPlanById(pv);
    if (token !== renderToken) return;
    const applied = pv === 'copilot' && S.applied[S.date];
    const active = applied ? applied.plan : base;
    const shown = Object.assign({}, active, { tasks: base.tasks || plan.tasks });
    const vs = pv === 'manual' ? plan : manual;
    const vsLabel = pv === 'manual' ? 'copilot' : 'as dispatched';
    const meta = plans.plans.find((p) => p.id === pv);
    S._planDecisions = active.decisions || [];
    S._shown = shown; S._isCustom = isCustom;
    const c = active.kpis;
    const planQS = pv === 'copilot' ? '' : `&plan=${encodeURIComponent(pv)}`;
    const title = pv === 'manual' ? 'As dispatched (George’s plan)' : pv === 'copilot' ? 'Copilot plan' : esc(meta.name);
    const sub = pv === 'manual'
      ? `What actually happened, rebuilt from ${SAMSARA} GPS visit order and re-costed with the same model for a fair comparison.`
      : pv === 'copilot'
        ? `Planned at 06:30 with freight already in the terminal and pickups already booked. Then <b>${plan.live.length} call-in pickups</b> were inserted live at the real time George dispatched them in ${ELITE}. Computed in ${fmt(plan.runtimeMs)} ms.`
        : `${base.custom.base === 'optimise' ? `Optimised for <b>${esc(base.custom.objective.label)}</b>: ${esc(base.custom.objective.text)}` : `Copy of the ${base.custom.base === 'manual' ? 'as-dispatched' : 'copilot'} plan, edited by hand.`} Use <b>Move to…</b> on any stop to change it; the impact is checked instantly.`;
    const st = isCustom ? base.custom.settings : null;
    // drivers picked for the map and the replay (kept per day and plan)
    const routeIds = shown.routes.filter((r) => r.nStops).map((r) => r.id);
    const colorOf = Object.fromEntries(shown.routes.map((r, i) => [r.id, routeColor(i)]));
    if (!S.drvSel || S.drvSelKey !== S.date + '|' + pv) { S.drvSel = new Set(); S.drvSelKey = S.date + '|' + pv; }
    for (const id of [...S.drvSel]) if (!routeIds.includes(id)) S.drvSel.delete(id);
    S.playLabel = playLabel();
    $('#view').innerHTML = `
      <div class="page-head">
        <div><div class="eyebrow">Plan the day · ${esc(cmp.weekday)} ${esc(S.date)}</div><h1>${title}</h1><p>${sub}</p>
          ${st && base.custom.base === 'optimise' ? `<div class="settings-chips"><span class="chip">${esc(base.custom.objective.label)}</span><span class="chip grey">${st.drivers ? st.drivers.length + ' drivers selected' : 'All drivers'}</span><span class="chip grey">Max ${st.maxDutyHours} h on duty</span><span class="chip grey">Depart ${hhmm(st.departTime)}</span><span class="chip grey">${st.serviceMin} min per stop</span><span class="chip grey">Partners ${st.allowPartner ? 'on' : 'off'}</span><span class="chip grey">Reloads ${st.allowReloads ? 'on' : 'off'}</span><span class="chip grey">Live replay ${st.liveReplay ? 'on' : 'off'}</span></div>` : ''}</div>
        <div class="row">
          ${isCustom ? `<button class="btn ghost sm" id="undoEdit" ${base.custom.moves.length ? '' : 'disabled'}>↶ Undo last edit</button><button class="btn ghost sm" id="delPlan">Delete plan</button>` : `<button class="btn ghost sm" id="copyPlan">Copy &amp; edit this plan</button>`}
          <a class="btn ghost sm" href="api/v1/export/${S.date}?format=csv&api_key=${API_KEY}${planQS}" ${Data.mode === 'local' ? 'data-local-export="1"' : ''}>${ICON.down} Dispatch file</a>
        </div>
      </div>
      <div class="plan-switch" style="margin-bottom:14px">
        ${plans.plans.map((p) => `<button data-pv="${esc(p.id)}" class="${p.id === pv ? 'on' : ''} ${p.kind === 'custom' ? 'custom' : ''}">${esc(p.name)}</button>`).join('')}
        <button class="add" id="newPlan">＋ Build a plan</button>
      </div>
      ${applied ? `<div class="banner applied">✓ <span>Showing plan after applying <b>${esc(applied.title)}</b> (${esc(applied.event)}). <a href="#" id="undoApply" style="color:#fff;text-decoration:underline">Revert to the original plan</a></span></div>` : ''}
      ${kpiTiles(c, vs.kpis, { vsLabel, fleet: active.fleet })}
      ${compareCard(plans, pv)}
      ${isCustom ? '' : eventsCard(active)}
      ${fleetMixCard(active, vs, vsLabel)}
      ${isCustom && base.custom.edits && base.custom.edits.length ? `<div class="card" style="margin-bottom:16px"><h3>Dispatcher edits (${base.custom.edits.length})</h3><ul class="decisions" style="max-height:220px">${base.custom.edits.map((e, i) => `<li><span class="time">#${i + 1}</span><div>${e.error ? `<div class="what">Could not re-apply ${esc(e.task)} → ${esc(e.target)}</div><div class="why">${esc(e.error)}</div>` : `<div class="what">${esc(e.label)} → ${esc(e.target === 'PARTNER' ? 'partner carrier' : e.target)} ${e.brokenRules.length ? `<span class="chip crit">breaks ${esc(e.brokenRules.join(', '))}</span>` : '<span class="chip ok">rules pass</span>'}</div><div class="why">${e.deltaCost >= 0 ? '+' : '−'}$${fmt(Math.abs(e.deltaCost))} day cost · ${e.deltaKm >= 0 ? '+' : '−'}${fmt(Math.abs(e.deltaKm))} km${e.to && e.to.after ? ` · ${esc(e.to.id)} now ends ${hhmm(e.to.after.end)} (${fmt(e.to.after.onDuty / 60, 1)} h on duty)` : ''}</div>`}</div></li>`).join('')}</ul></div>` : ''}
      <div class="plan-layout">
        <div>
          <div id="drvSel" class="drvsel"></div>
          <div id="map" class="map"></div>
          <div class="replay">
            <button class="btn sm" id="playBtn">${ICON.play} ${S.playLabel}</button>
            <input type="range" id="tSlider" min="330" max="1320" step="5" value="${S.replayT == null ? 1320 : S.replayT}" aria-label="Time of day" />
            <span class="clock" id="clock">${S.replayT == null ? 'All day' : hhmm(S.replayT)}</span>
          </div>
          <div class="ticker" id="ticker"></div>
        </div>
        <div class="card route-list">
          <div class="row" style="justify-content:space-between;margin-bottom:8px"><h3 style="margin:0">Routes</h3><span class="muted small">${shown.routes.filter((r) => r.nStops).length} trucks · ${(shown.partner || []).length} partner tenders · tick to show on the map, click a row for details</span></div>
          <table class="tbl"><thead><tr><th class="pick-cell" title="Show these drivers on the map"><input type="checkbox" id="selAll" aria-label="Select all drivers" /></th><th>Route</th><th>Stops</th><th>km</th><th style="min-width:70px">Hours</th><th style="min-width:70px">Weight</th><th style="min-width:70px">Floor</th></tr></thead>
          <tbody>${shown.routes.map((r, i) => (r.nStops ? `<tr class="click ${S.selectedRoute === r.id ? 'sel' : ''}" data-route="${r.id}">
              <td class="pick-cell"><input type="checkbox" data-pick="${r.id}" ${S.drvSel.has(r.id) ? 'checked' : ''} style="accent-color:${routeColor(i)}" aria-label="Show ${esc(r.driverName)} on the map" title="Show on the map" /><span class="dot" style="background:${routeColor(i)}"></span></td>
              <td><b>${r.id}</b> ${r.broken ? '<span class="chip crit">OUT</span>' : ''}${r.violations.some((v) => v.hard) ? '<span class="chip crit">!</span>' : ''}<div class="small muted">${esc(r.driverName)} · ${esc(VEH_SHORT[r.cls] || '')} ${esc((r.vehicle || '').replace(/^(Truck|Tractor) /, ''))}</div></td>
              <td class="num">${r.nStops}${r.stops.some((s) => s.live != null) ? ` <span class="chip live" title="stops inserted live">+${r.stops.filter((s) => s.live != null).length}</span>` : ''}${r.stops.some((s) => s.edited) ? ' <span class="chip warn" title="edited by the dispatcher">✎</span>' : ''}</td>
              <td class="num">${fmt(r.km)}</td>
              <td>${bar(r.utilHours)}</td><td>${bar(r.utilLb)}</td><td>${bar(r.utilSpots)}</td></tr>` : '')).join('')}
            ${shown.routes.filter((r) => !r.nStops).length ? `<tr><td></td><td colspan="6" class="small"><b>On standby (${shown.routes.filter((r) => !r.nStops).length}):</b> <span class="muted">${shown.routes.filter((r) => !r.nStops).map((r) => `${esc(r.driverName.split(' ')[0])} (${esc(VEH_SHORT[r.cls])})`).join(', ')}</span>${isCustom ? '<div class="muted">Use “Move to…” on any stop to put one of these trucks to work.</div>' : ''}</td></tr>` : ''}
          </tbody></table>
          ${(shown.partner || []).length ? `<div class="divider"></div><h3>Partner carrier tenders</h3><table class="tbl"><tbody>${shown.partner.map((p) => `<tr><td><b>${p.tasks.map((id) => esc((shown.tasks.find((t) => t.id === id) || {}).orders || id)).join(' + ')}</b><div class="small muted">${esc(p.reason)}</div>${isCustom ? moveSelect(p.tasks[0], 'PARTNER', shown, 'Bring in-house…') : ''}</td><td class="num">${money(p.quote)}</td></tr>`).join('')}</tbody></table>` : ''}
        </div>
      </div>
      <div id="detail" class="detail"></div>
      ${(active.decisions || []).length ? `<div class="card" style="margin-top:16px"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Decision log (${active.decisions.length})</h3><div class="row"><div class="filters" id="decFilters" style="margin:0">${['All', 'assign', 'live_insert', 'partner', 'improve', 'manual_edit'].map((f, i) => `<button data-f="${f}" class="${i === 0 ? 'on' : ''}">${{ All: 'All', assign: 'Assign', live_insert: 'Live', partner: 'Partner', improve: 'Improve', manual_edit: 'Edits' }[f]}</button>`).join('')}</div><a class="btn ghost sm" href="api/v1/decisions/${S.date}?format=csv&api_key=${API_KEY}${planQS}">${ICON.down} Save log (CSV)</a></div></div><ul class="decisions" id="decList"></ul></div>` : ''}
    `;
    ensureMap($('#map'));
    const redraw = (fit) => drawRoutes(shown, { time: S.replayT, onRoute: selectRoute, fit, only: S.drvSel });
    redraw(true);
    renderSelBar();
    syncPicks();
    renderDetail(shown);
    renderDecisions(active, 'All');
    $$('[data-pv]').forEach((b) => b.addEventListener('click', () => { S.planView = b.dataset.pv; S.selectedRoute = null; route(); }));
    $$('[data-open-plan]').forEach((tr) => tr.addEventListener('click', () => { S.planView = tr.dataset.openPlan; S.selectedRoute = null; route(); }));
    $('#newPlan').addEventListener('click', () => openBuilder());
    const cp = $('#copyPlan');
    if (cp) cp.addEventListener('click', () => copyPlan(pv));
    const ue = $('#undoEdit');
    if (ue) ue.addEventListener('click', async () => { ue.disabled = true; const p = await Data.post(`plans/${S.date}/${pv}/undo`, {}); setPlanCache(pv, p); toast('Last edit undone.', 'good'); route(); });
    const dp = $('#delPlan');
    if (dp) dp.addEventListener('click', async () => { if (!confirm(`Delete “${meta.name}”?`)) return; await Data.del(`plans/${S.date}/${pv}`); invalidatePlans(); S.planView = 'copilot'; route(); });
    $$('tr[data-route]').forEach((tr) => tr.addEventListener('click', () => selectRoute(tr.dataset.route)));
    $$('#decFilters button').forEach((b) => b.addEventListener('click', () => { $$('#decFilters button').forEach((x) => x.classList.toggle('on', x === b)); renderDecisions(active, b.dataset.f); }));
    const undo = $('#undoApply');
    if (undo) undo.addEventListener('click', (e) => { e.preventDefault(); delete S.applied[S.date]; route(); });
    const exp = $('[data-local-export]');
    if (exp) exp.addEventListener('click', (e) => { e.preventDefault(); localExport(); });
    const slider = $('#tSlider');
    slider.addEventListener('input', () => { S.replayT = Number(slider.value) >= 1320 ? null : Number(slider.value); $('#clock').textContent = S.replayT == null ? 'All day' : hhmm(S.replayT); redraw(false); renderTicker(active); });
    $('#playBtn').addEventListener('click', () => { if (S.playing) return stopReplay(); startReplay(); });
    // picking drivers: tick boxes in the routes list, the header box, or "Show only this driver" in a route's detail
    $$('.pick-cell').forEach((td) => td.addEventListener('click', (e) => e.stopPropagation()));
    $$('[data-pick]').forEach((cb) => cb.addEventListener('change', () => { if (cb.checked) S.drvSel.add(cb.dataset.pick); else S.drvSel.delete(cb.dataset.pick); onSelChange(); }));
    $('#selAll').addEventListener('change', (e) => { if (e.target.checked) routeIds.forEach((id) => S.drvSel.add(id)); else S.drvSel.clear(); onSelChange(); });
    S._onSelChange = onSelChange;

    function playLabel() {
      const n = S.drvSel ? S.drvSel.size : 0;
      return n === 0 || n === routeIds.length ? 'Replay day' : n === 1 ? 'Replay this driver\'s day' : `Replay ${n} drivers' day`;
    }
    function syncPicks() {
      $$('[data-pick]').forEach((cb) => (cb.checked = S.drvSel.has(cb.dataset.pick)));
      const all = $('#selAll');
      all.checked = S.drvSel.size > 0 && S.drvSel.size === routeIds.length;
      all.indeterminate = S.drvSel.size > 0 && S.drvSel.size < routeIds.length;
    }
    function onSelChange() {
      stopReplay();
      S.replayT = null;
      slider.value = 1320; $('#clock').textContent = 'All day';
      S.playLabel = playLabel();
      $('#playBtn').innerHTML = `${ICON.play} ${S.playLabel}`;
      syncPicks(); renderSelBar(); redraw(true); renderTicker(active);
    }
    function renderSelBar() {
      const el = $('#drvSel');
      if (!el) return;
      if (!S.drvSel.size) {
        el.innerHTML = `<span class="small muted">Showing all ${routeIds.length} drivers. Tick drivers in the Routes list to see just their day and replay it.</span>`;
        return;
      }
      const rs = shown.routes.filter((r) => S.drvSel.has(r.id));
      const sum = (f) => rs.reduce((a, r) => a + (f(r) || 0), 0);
      const live = sum((r) => r.stops.filter((s) => s.live != null).length);
      const start = Math.min(...rs.map((r) => (r.start == null ? 1440 : r.start)));
      const end = Math.max(...rs.map((r) => (r.end == null ? 0 : r.end)));
      el.innerHTML = `<div class="drvsel-chips">${rs.length === routeIds.length ? '<span class="drv-chip" style="border-color:var(--blue);padding-right:9px">All drivers</span>' : rs.map((r) => `<span class="drv-chip" style="border-color:${colorOf[r.id]}"><i style="background:${colorOf[r.id]}"></i>${esc(r.id)} · ${esc(r.driverName.split(' ')[0])}<button data-unpick="${r.id}" aria-label="Remove ${esc(r.driverName)}" title="Remove">×</button></span>`).join('')}</div>
        <div class="drvsel-stats small"><b>${rs.length} driver${rs.length > 1 ? 's' : ''}</b> · ${fmt(sum((r) => r.nStops))} stops · ${fmt(sum((r) => r.km))} km · ${fmt(sum((r) => r.onDutyMin) / 60, 1)} h on duty${live ? ` · ${live} stop${live > 1 ? 's' : ''} added live` : ''} · ${hhmm(start)}–${hhmm(end)}</div>
        <div class="row"><button class="btn sm" id="selPlay">${ICON.play} ${esc(S.playLabel)}</button><button class="btn ghost sm" id="selClear">Show all drivers</button></div>`;
      $$('[data-unpick]', el).forEach((x) => x.addEventListener('click', () => { S.drvSel.delete(x.dataset.unpick); onSelChange(); }));
      $('#selPlay', el).addEventListener('click', () => { if (!S.playing) startReplay(); $('#map').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
      $('#selClear', el).addEventListener('click', () => { S.drvSel.clear(); onSelChange(); });
    }
    function startReplay() {
      stopReplay();
      const rs = S.drvSel.size ? shown.routes.filter((r) => S.drvSel.has(r.id)) : null;
      // a selection replays from its first start to its last finish, a little slower so each truck can be followed
      const from = rs ? Math.max(180, Math.floor((Math.min(...rs.map((r) => (r.start == null ? 360 : r.start))) - 10) / 5) * 5) : 360;
      const until = rs ? Math.min(1430, Math.max(...rs.map((r) => (r.end == null ? 1320 : r.end))) + 15) : 1320;
      const step = rs ? 4 : 6;
      if (S.replayT == null || S.replayT >= until - step || S.replayT < from) S.replayT = from;
      slider.min = Math.min(330, from);
      $('#playBtn').innerHTML = `${ICON.pause} Pause`;
      S.playing = setInterval(() => {
        S.replayT += step;
        if (S.replayT >= until) { stopReplay(); S.replayT = null; }
        slider.value = S.replayT == null ? 1320 : S.replayT;
        $('#clock').textContent = S.replayT == null ? 'All day' : hhmm(S.replayT);
        redraw(false); renderTicker(active);
      }, 120);
    }
    function selectRoute(id) {
      S.selectedRoute = S.selectedRoute === id ? null : id;
      $$('tr[data-route]').forEach((tr) => tr.classList.toggle('sel', tr.dataset.route === S.selectedRoute));
      redraw(true); renderDetail(shown);
      if (S.selectedRoute) $('#detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  const VEH_SHORT = { STRAIGHT_26: '26′', TRACTOR_53: '53′', CARGO_VAN: 'van' };
  function moveSelect(taskId, currentRoute, plan, label) {
    const opts = plan.routes.filter((r) => r.id !== currentRoute).map((r) => `<option value="${r.id}">${r.id} · ${esc(r.driverName.split(' ')[0])} · ${VEH_SHORT[r.cls]}${r.nStops ? ` · ${r.nStops} stops` : ' · standby'}</option>`).join('');
    return `<select class="movesel" data-move="${esc(taskId)}" title="Move this stop (and its paired leg) to another truck"><option value="">${label || 'Move to…'}</option>${opts}${currentRoute !== 'PARTNER' ? '<option value="PARTNER">Partner carrier</option>' : ''}</select>`;
  }
  async function onMoveSelect(e) {
    const sel = e.target.closest('select[data-move]');
    if (!sel || !sel.value) return;
    const target = sel.value, task = sel.dataset.move, pv = S.planView;
    sel.disabled = true;
    try {
      const res = await Data.post(`plans/${S.date}/${pv}/moves`, { task, target });
      setPlanCache(pv, res.plan);
      const i = res.impact;
      const ok = !i.brokenRules.length;
      toast(`<b>${esc(i.label)}</b> → ${esc(target === 'PARTNER' ? 'partner carrier' : target)}<br>${i.deltaCost >= 0 ? '+' : '−'}$${fmt(Math.abs(i.deltaCost))} day cost · ${i.deltaKm >= 0 ? '+' : '−'}${fmt(Math.abs(i.deltaKm))} km${i.to && i.to.after ? ` · ${esc(i.to.id)} ends ${hhmm(i.to.after.end)}` : ''}<br>${ok ? '✓ All rules still pass' : `⚠ Breaks: ${esc(i.brokenRules.join(', '))}${i.equipmentOk ? '' : ' (wrong vehicle type)'} — undo if this was not intended`}`, ok ? 'good' : 'bad');
      if (target !== 'PARTNER') S.selectedRoute = target;
      route();
    } catch (err) { toast('Could not move: ' + esc(err.message), 'bad'); sel.disabled = false; }
  }
  function toast(html, kind) {
    const old = $('.toast');
    if (old) old.remove();
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.innerHTML = html;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 6500);
  }
  async function copyPlan(pv) {
    const res = await Data.post(`plans/${S.date}`, { name: `${pv === 'manual' ? 'As dispatched' : 'Copilot'} – my edits`, base: pv });
    setPlanCache(res.planId, res);
    invalidatePlans();
    S.planView = res.planId;
    toast('Copy created. Use <b>Move to…</b> on any stop to edit it.', 'good');
    route();
  }

  // ---- custom plan builder
  async function openBuilder() {
    const fl = await Data.get('fleet/' + S.date);
    const groups = {};
    fl.drivers.forEach((d) => (groups[d.vehicleClass] = groups[d.vehicleClass] || []).push(d));
    const order = ['TRACTOR_53', 'STRAIGHT_26', 'CARGO_VAN'];
    const def = fl.defaults;
    const times = [300, 330, 360, 390, 420, 450, 480, 510, 540];
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<form class="modal" id="builder">
      <div class="modal-head"><div><div class="eyebrow">${esc(S.date)}</div><h2 style="font-size:19px">Build a custom plan</h2></div><button type="button" class="btn ghost sm" data-close>✕</button></div>
      <div class="modal-body">
        <div class="form-row"><label class="field" style="flex:1">Plan name<input type="text" name="name" value="My plan ${new Date().toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' })}" maxlength="60" style="width:100%" /></label></div>
        <div><h4>Start from</h4><div class="choice">
          <label><input type="radio" name="base" value="optimise" checked /><b>Optimise with my settings</b><span>The copilot re-plans the day with the fleet and rules below.</span></label>
          <label><input type="radio" name="base" value="copilot" /><b>Copy the copilot plan</b><span>Start from today's recommendation and move stops by hand.</span></label>
          <label><input type="radio" name="base" value="manual" /><b>Copy George's plan</b><span>Start from what was actually dispatched and improve it by hand.</span></label>
        </div></div>
        <div data-opt-only><h4>What matters most today</h4><div class="choice">${Object.entries(fl.objectives).map(([k, o]) => `<label><input type="radio" name="objective" value="${k}" ${k === def.objective ? 'checked' : ''} /><b>${esc(o.label)}</b><span>${esc(o.text)}</span></label>`).join('')}</div></div>
        <div data-opt-only><h4>Fleet available (${fl.drivers.length} drivers and units)</h4><div class="fleet-pick">${order.filter((c) => groups[c]).map((c) => `<div class="grp"><div class="grp-h"><span>${esc(groups[c][0].vehicleLabel)} (${groups[c].length})</span><span><a href="#" data-all="${c}">all</a> · <a href="#" data-none="${c}">none</a></span></div>${groups[c].map((d) => `<label><input type="checkbox" name="drv" value="${esc(d.code)}" data-cls="${c}" checked />${esc(d.name)} <span class="muted">· ${esc(d.vehicle || 'unit unknown')} · ${esc(d.licence)}</span></label>`).join('')}</div>`).join('')}</div></div>
        <div data-opt-only><h4>Rules for the day</h4><div class="form-row">
          <label class="field">Max on-duty hours<select name="maxDutyHours">${[8, 9, 10, 11, 12, 13, 14].map((h) => `<option ${h === def.maxDutyHours ? 'selected' : ''}>${h}</option>`).join('')}</select></label>
          <label class="field">First departure<select name="departTime">${times.map((t) => `<option value="${t}" ${t === def.departTime ? 'selected' : ''}>${hhmm(t)}</option>`).join('')}</select></label>
          <label class="field">Minutes per stop<input type="number" name="serviceMin" min="5" max="40" value="${def.serviceMin}" style="width:90px" /></label>
        </div>
        <div class="form-row" style="margin-top:12px;gap:22px">
          <label class="toggle"><input type="checkbox" name="allowPartner" checked />Use partner carriers when cheaper</label>
          <label class="toggle"><input type="checkbox" name="allowReloads" checked />Allow mid-day terminal reloads</label>
          <label class="toggle"><input type="checkbox" name="liveReplay" checked />Insert call-ins at their real dispatch time</label>
          <label class="toggle"><input type="checkbox" name="events" ${S.events ? 'checked' : ''} />Include simulated road &amp; weather events</label>
        </div></div>
      </div>
      <div class="modal-foot"><span class="muted small" id="bStatus" style="margin-right:auto;align-self:center"></span><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn">${ICON.arrow} Build plan</button></div>
    </form>`;
    document.body.appendChild(bg);
    const f = $('#builder');
    const close = () => bg.remove();
    $$('[data-close]', bg).forEach((b) => b.addEventListener('click', close));
    bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
    $$('[data-all]', bg).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); $$(`input[data-cls="${a.dataset.all}"]`, bg).forEach((x) => (x.checked = true)); }));
    $$('[data-none]', bg).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); $$(`input[data-cls="${a.dataset.none}"]`, bg).forEach((x) => (x.checked = false)); }));
    const syncBase = () => { const opt = f.base.value === 'optimise'; $$('[data-opt-only]', bg).forEach((x) => (x.style.display = opt ? '' : 'none')); };
    $$('input[name=base]', bg).forEach((x) => x.addEventListener('change', syncBase));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const drivers = $$('input[name=drv]:checked', bg).map((x) => x.value);
      if (f.base.value === 'optimise' && !drivers.length) { $('#bStatus').textContent = 'Pick at least one driver.'; return; }
      const body = {
        name: f.name.value.trim() || 'Custom plan', base: f.base.value,
        settings: { objective: f.objective.value, maxDutyHours: Number(f.maxDutyHours.value), departTime: Number(f.departTime.value), serviceMin: Number(f.serviceMin.value), allowPartner: f.allowPartner.checked, allowReloads: f.allowReloads.checked, liveReplay: f.liveReplay.checked, events: f.events.checked ? 'on' : 'off', drivers: drivers.length === fl.drivers.length ? null : drivers },
      };
      $('#bStatus').innerHTML = '<span class="spinner" style="vertical-align:middle"></span> Planning ' + (body.settings.liveReplay && body.base === 'optimise' ? 'and replaying call-ins…' : '…');
      $$('button', f).forEach((b) => (b.disabled = true));
      try {
        const res = await Data.post(`plans/${S.date}`, body);
        setPlanCache(res.planId, res);
        invalidatePlans();
        S.planView = res.planId; S.selectedRoute = null;
        close();
        toast(`<b>${esc(body.name)}</b> built: ${res.kpis.trucksUsed} trucks, ${fmt(res.kpis.onTimePct, 1)}% on time, ${money(res.kpis.totalCost)}.`, 'good');
        route();
      } catch (err) { $('#bStatus').textContent = 'Could not build: ' + err.message; $$('button', f).forEach((b) => (b.disabled = false)); }
    });
  }

  function stopReplay() {
    if (S.playing) { clearInterval(S.playing); S.playing = null; }
    const b = $('#playBtn');
    if (b) b.innerHTML = `${ICON.play} ${S.playLabel || 'Replay day'}`;
  }
  function renderTicker(plan) {
    const el = $('#ticker');
    if (!el) return;
    if (S.replayT == null) { el.innerHTML = ''; return; }
    const sel = S.drvSel && S.drvSel.size ? S.drvSel : null;
    const evs = (plan.decisions || []).filter((d) => d.type === 'live_insert' && d.time <= S.replayT && (!sel || sel.has(d.route))).slice(-3).reverse();
    el.innerHTML = evs.map((d) => `<div class="ev"><b>${hhmm(d.time)}</b> · ${esc(d.decision)}: <span class="muted">${esc(d.subject)}</span></div>`).join('') || '<div class="muted small">06:30 plan locked. Waiting for call-ins…</div>';
  }
  function renderDecisions(plan, f) {
    const el = $('#decList');
    if (!el) return;
    const list = (plan.decisions || []).filter((d) => f === 'All' || d.type === f).filter((d) => !S.selectedRoute || d.route === S.selectedRoute || f !== 'All');
    el.innerHTML = list.slice(-300).map((d) => `<li><span class="time">${d.time == null ? 'edit' : hhmm(d.time)}</span><div><div class="what">${esc(d.decision)} <span class="chip ${d.type === 'live_insert' ? 'live' : d.type === 'partner' || d.type === 'manual_edit' ? 'warn' : 'grey'}">${esc(d.type.replace('_', ' '))}</span> ${d.confidence === 'low' ? '<span class="chip crit">low confidence</span>' : ''}</div><div class="why"><b>${esc(d.subject)}</b> — ${esc(d.reason)}</div></div></li>`).join('') || '<li class="muted">No decisions in this category.</li>';
  }
  function renderDetail(plan) {
    const el = $('#detail');
    if (!el) return;
    const r = plan.routes.find((x) => x.id === S.selectedRoute);
    if (!r) { el.innerHTML = ''; return; }
    const T = taskMap(plan);
    const idx = plan.routes.indexOf(r);
    const color = routeColor(idx);
    const lp = r.loadPlan;
    const cellOwner = {};
    if (lp) lp.items.forEach((it) => it.cells.forEach((c) => (cellOwner[c] = cellOwner[c] || it)));
    const nItems = lp ? lp.items.length : 0;
    const shade = (k) => `hsl(${225 - (k / Math.max(1, nItems)) * 40}, 80%, ${30 + (k / Math.max(1, nItems)) * 35}%)`;
    const decisions = (S._planDecisions || []).filter((d) => d.route === r.id);
    el.innerHTML = `<div class="card">
      <div class="detail-head"><span class="dot" style="background:${color};width:14px;height:14px"></span><h3>${r.id} · ${esc(r.driverName)}</h3>
        <span class="chip grey">${esc(r.vehicle)}</span><span class="chip">${esc(r.vehicleLabel)}</span><span class="chip grey">Licence ${esc(r.licence)} (inferred)</span>${r.vehicleUnknown ? '<span class="chip est">Unit unknown</span>' : ''}
        <span class="muted small" style="margin-left:auto">${hhmm(r.start)} – ${hhmm(r.end)} · ${fmt(r.km)} km · ${fmt(r.driveMin / 60, 1)} h driving · ${fmt(r.onDutyMin / 60, 1)} h on duty</span></div>
      <div class="row" style="margin-top:10px"><button class="btn ghost sm" data-only="${r.id}">${ICON.play} Show only this driver on the map</button></div>
      ${S._isCustom ? '' : `<p class="small muted" style="margin-top:8px">Want to change this route? <a href="#" data-copy-edit>Copy this plan and edit it</a>; every stop gets a “Move to…” control.</p>`}
      <div class="grid g3" style="margin-top:14px">
        ${bar(r.utilHours, `Hours (${(plan.settings && plan.settings.maxDutyHours) || 14} h limit)`)}${bar(r.utilLb, `Peak weight ${fmt(r.peakLb)} / ${fmt(r.capacity.lb)} lb`)}${bar(r.utilSpots, `Peak floor ${fmt(r.peakSpots, 1)} / ${r.capacity.spots} spots`)}
      </div>
      <div class="grid g2" style="margin-top:16px">
        <div><h3>Stop sequence</h3><ul class="stops">${r.stops.map((s) => {
          if (s.depot) return `<li><span class="t">${hhmm(s.arr)}</span><span class="k T">T</span><div><div class="who">Scarborough terminal</div><div class="meta">Reload ${hhmm(s.arr)}–${hhmm(s.dep)}</div></div><div></div></li>`;
          const t = T[s.id];
          if (!t) return '';
          return `<li><span class="t">${hhmm(s.arr)}</span><span class="k ${kindLetter(t.kind)}">${kindLetter(t.kind)}</span><div><div class="who">${esc(t.city || '')} <span class="muted" style="font-weight:400">· ${esc(t.customer || '')}</span></div><div class="meta">${esc(t.orders.join(', '))} · ${fmt(t.weight)} lb · ${fmt(t.spots, t.spots % 1 ? 1 : 0)} spot${t.spots === 1 ? '' : 's'} · window ${hhmm(t.earliest)}–${hhmm(t.hardLatest != null ? t.hardLatest : t.latest)}${s.wait ? ` · waits ${s.wait} min` : ''}</div>${s.why ? whyBlock(s.why) : ''}</div><div class="flags">${evChips(s.ev, plan.events)}${flagsFor(t, s)}${S._isCustom ? moveSelect(s.id, r.id, plan) : ''}</div></li>`;
        }).join('')}</ul></div>
        <div>
          ${lp ? `<h3>Load plan (LIFO)</h3><div class="deck-wrap"><div class="deck" style="margin:20px 0">${Array.from({ length: lp.cells }, (_, c) => { const it = cellOwner[c]; return it ? `<div class="cell ${it.dg ? 'dg' : ''} ${it.estimated ? 'est' : ''}" style="background:${shade(it.loadOrder - 1)}" title="${esc(it.id)} · ${fmt(it.weight)} lb">${it.deliveryOrder}</div>` : '<div class="cell free">·</div>'; }).join('')}</div>
            <div><ol class="load-list">${lp.items.map((it) => `<li>Load <b>#${it.loadOrder}</b> → delivery stop ${it.deliveryOrder}: ${esc((T[it.id] || {}).city || it.id)}, ${fmt(it.weight)} lb, ${fmt(it.spots, it.spots % 1 ? 2 : 0)} spot(s)${it.dg ? ' <span class="chip crit">DG</span>' : ''}${it.estimated ? ' <span class="chip est">EST</span>' : ''}</li>`).join('')}</ol>
            <p class="small muted" style="margin-top:8px">${lp.used}/${lp.cells} spots used at departure${lp.pickupsReserved ? ` · ${lp.pickupsReserved} spot(s) needed for pickups later` : ''}.</p>
            <ul class="small" style="padding-left:18px;margin-top:6px">${lp.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div></div>` : '<p class="muted">No terminal freight on this route.</p>'}
          ${r.violations && r.violations.length ? `<div class="divider"></div><h3>Rule checks</h3>${r.violations.map((v) => `<div class="chip ${v.hard ? 'crit' : 'warn'}" style="margin:2px">${esc(v.type)}${v.by ? ' +' + v.by : ''}</div>`).join('')}` : '<div class="divider"></div><span class="chip ok">✓ Capacity, equipment, HOS and appointment checks pass</span>'}
          ${decisions.length ? `<div class="divider"></div><h3>Why this route looks like this</h3><ul class="decisions" style="max-height:260px">${decisions.map((d) => `<li><span class="time">${hhmm(d.time)}</span><div><div class="what">${esc(d.decision)}</div><div class="why"><b>${esc(d.subject)}</b> — ${esc(d.reason)}</div></div></li>`).join('')}</ul>` : ''}
        </div>
      </div></div>`;
    const ob = $('[data-only]', el);
    if (ob) ob.addEventListener('click', () => { S.drvSel = new Set([r.id]); if (S._onSelChange) S._onSelChange(); $('#drvSel').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    const ce = $('[data-copy-edit]', el);
    if (ce) ce.addEventListener('click', (e) => { e.preventDefault(); copyPlan(S.planView); });
  }
  async function localExport() {
    const E = window.CopilotEngine;
    const p = S.planView === 'copilot' ? Data.local.plan(S.date) : S.planView === 'manual' ? Data.local.manual(S.date) : Data.local.custom[S.planView];
    const blob = new Blob([E.toCSV(E.toDispatchRows(p))], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `copilot-dispatch-${S.date}.csv`; a.click();
  }

  // ================================================================== PROBLEMS
  async function viewProblems(token) {
    const plans = await getPlans();
    if (!plans.plans.some((p) => p.id === S.problemsView)) S.problemsView = 'manual';
    const all = await Promise.all(plans.plans.map((p) => getConflicts(p.id)));
    if (token !== renderToken) return;
    const which = S.problemsView;
    const idx = plans.plans.findIndex((p) => p.id === which);
    const list = all[idx].conflicts;
    const count = (l, sv) => l.filter((x) => x.severity === sv).length;
    const cats = ['All'].concat([...new Set(list.map((x) => x.category))]);
    if (!cats.includes(S.problemsFilter)) S.problemsFilter = 'All';
    const shownList = list.filter((x) => S.problemsFilter === 'All' || x.category === S.problemsFilter);
    return `
      <div class="page-head"><div><div class="eyebrow">Identify potential problems · ${esc(S.date)}</div><h1>Catch it before the truck leaves the yard</h1>
        <p>The same checks run on every plan: capacity, the right vehicle type, hours of service, appointments, dangerous goods, consolidation and missing data. Each finding comes with a suggested fix.</p></div>
        <div class="plan-switch">${plans.plans.map((p) => `<button data-pv="${esc(p.id)}" class="${which === p.id ? 'on' : ''} ${p.kind === 'custom' ? 'custom' : ''}">${esc(p.name)}</button>`).join('')}</div></div>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr));margin-bottom:16px">
        ${plans.plans.map((p, i) => `<div class="card" style="${p.id === which ? 'box-shadow:0 0 0 2px var(--blue),var(--shadow)' : ''}"><h3>${esc(p.name)}</h3><div class="sev-sum"><div class="s critical"><b>${count(all[i].conflicts, 'critical')}</b>critical</div><div class="s warning"><b>${count(all[i].conflicts, 'warning')}</b>warnings</div><div class="s info"><b>${count(all[i].conflicts, 'info')}</b>info</div></div></div>`).join('')}
      </div>
      <div class="card">
        <div class="filters">${cats.map((c) => `<button data-cat="${esc(c)}" class="${S.problemsFilter === c ? 'on' : ''}">${esc(c)} ${c === 'All' ? list.length : list.filter((x) => x.category === c).length}</button>`).join('')}</div>
        ${shownList.map((x) => `<div class="issue ${x.severity}"><div class="ic">${x.severity === 'info' ? ICON.info : ICON.alert}</div><div><div class="title">${esc(x.title)} <span class="chip ${x.severity === 'critical' ? 'crit' : x.severity === 'warning' ? 'warn' : ''}">${esc(x.category)}</span>${x.refs && x.refs.route ? ` <a href="#/plan" data-goto-route="${esc(x.refs.route)}" class="small">${esc(x.refs.route)} →</a>` : ''}</div><div class="det">${esc(x.detail)}</div>${x.refs && x.refs.why ? whyBlock(x.refs.why, x.severity === 'critical') : ''}<div class="fix"><b>Suggested fix:</b> ${esc(x.fix)}</div></div></div>`).join('') || '<div class="empty">No findings in this category.</div>'}
      </div>`;
  }
  viewProblems.after = function () {
    $$('[data-pv]').forEach((b) => b.addEventListener('click', () => { S.problemsView = b.dataset.pv; route(); }));
    $$('[data-cat]').forEach((b) => b.addEventListener('click', () => { S.problemsFilter = b.dataset.cat; route(); }));
    $$('[data-goto-route]').forEach((a) => a.addEventListener('click', () => { S.selectedRoute = a.dataset.gotoRoute; S.planView = S.problemsView; }));
  };

  // ================================================================== ADAPT
  async function viewAdapt(token) {
    const [sc, plan] = await Promise.all([getScenarios(), getPlan()]);
    if (token !== renderToken) return;
    const scen = sc.scenarios;
    if (!S.scenario || S.scenario.date !== S.date) S.scenario = Object.assign({ date: S.date }, scen[0]);
    const cur = S.scenario;
    const routesWithStops = plan.routes.filter((r) => r.nStops);
    $('#view').innerHTML = `
      <div class="page-head"><div><div class="eyebrow">Adapt when things change · ${esc(S.date)}</div><h1>Something just went wrong. Here are your options.</h1>
        <p>Everything that has already happened is frozen: completed stops and freight on board. Only the rest of the day is re-planned, and each option is costed against the plan as it stands at that moment.</p></div></div>
      <div class="scen">${scen.map((s) => `<button data-scen="${s.type}" class="${cur.type === s.type ? 'on' : ''}"><span class="ico">${ICON[s.icon] || ICON.alert}</span><b>${esc(s.title)}</b><span>${esc(s.description)}</span></button>`).join('')}</div>
      <div class="card" style="margin-bottom:16px"><div class="params">
        ${cur.type === 'breakdown' || cur.type === 'driver_absent' ? `<label class="field">Route / driver<select id="pRoute">${routesWithStops.map((r) => `<option value="${r.id}" ${r.id === cur.route ? 'selected' : ''}>${r.id} · ${esc(r.driverName)} · ${esc(r.vehicle)}</option>`).join('')}</select></label>` : ''}
        <label class="field">Time of event <span id="pTimeLbl" style="text-transform:none;color:var(--ink);font-size:14px">${hhmm(cur.time)}</span><input type="range" id="pTime" min="360" max="1080" step="5" value="${cur.time}" /></label>
        <button class="btn" id="runBtn">${ICON.arrow} Find recovery options</button>
        <span class="muted small" id="runInfo"></span>
      </div></div>
      <div id="adaptOut"></div>`;
    $$('[data-scen]').forEach((b) => b.addEventListener('click', () => { const s = scen.find((x) => x.type === b.dataset.scen); S.scenario = Object.assign({ date: S.date }, s); S.disruption = null; route(); }));
    const pr = $('#pRoute');
    if (pr) pr.addEventListener('change', () => { cur.route = pr.value; });
    $('#pTime').addEventListener('input', (e) => { cur.time = Number(e.target.value); $('#pTimeLbl').textContent = hhmm(cur.time); });
    $('#runBtn').addEventListener('click', runDisruption);
    if (S.disruption && S.disruption.date === S.date && S.disruption.event.type === cur.type) renderDisruption();
    else runDisruption();
  }
  async function runDisruption() {
    const cur = S.scenario;
    const out = $('#adaptOut');
    out.innerHTML = '<div class="loading"><span class="spinner"></span>Freezing completed work and re-planning…</div>';
    const t0 = performance.now();
    try {
      const body = { type: cur.type, time: cur.time };
      if (cur.route) body.route = cur.route;
      if (cur.pickup) body.pickup = cur.pickup;
      if (cur.task) body.task = cur.task;
      ['reason', 'reasons', 'delayMin', 'extraKm', 'title', 'description', 'icon', 'source'].forEach((k) => { if (cur[k] != null) body[k] = cur[k]; });
      const res = await Data.post('disruptions/' + S.date, body);
      res.ms = Math.round(performance.now() - t0);
      S.disruption = res;
      S.selectedOption = res.recommended;
      renderDisruption();
    } catch (e) {
      out.innerHTML = `<div class="card empty">Could not evaluate: ${esc(e.message)}</div>`;
    }
  }
  async function renderDisruption() {
    const res = S.disruption;
    const plan = await getPlan();
    const out = $('#adaptOut');
    if (!out) return;
    $('#runInfo').textContent = `Evaluated ${res.options.length} options in ${fmt(res.ms)} ms`;
    const rec = res.options.find((o) => o.id === res.recommended);
    const d = (v, unit, lowerBetter) => { const good = lowerBetter ? v < 0 : v > 0; const z = Math.abs(v) < 0.5; return `<b class="delta ${z ? '' : good ? 'good' : 'bad'}">${v > 0 ? '+' : v < 0 ? '−' : ''}${unit === '$' ? '$' + fmt(Math.abs(v)) : fmt(Math.abs(v)) + (unit || '')}</b>`; };
    const sel = res.options.find((o) => o.id === S.selectedOption) || rec;
    out.innerHTML = `
      <div class="banner"><span style="font-size:20px">⚡</span><div><div><b>${esc(res.event.title || res.event.type)} at ${esc(res.event.timeLabel)}</b> · ${esc(res.event.description || '')}</div><div style="margin-top:4px">Recommendation: <b>${esc(rec.id)}. ${esc(rec.title)}</b>. ${esc(res.rationale)}</div></div></div>
      <div class="options">${res.options.map((o) => `<div class="opt ${o.id === res.recommended ? 'rec' : ''} ${o.id === sel.id ? 'sel' : ''}" data-opt="${o.id}">
        <div class="row" style="justify-content:space-between"><h4>${esc(o.id)}. ${esc(o.title)}</h4>${o.id === res.recommended ? '<span class="chip">Recommended</span>' : ''}${!o.feasible ? '<span class="chip crit">Rule breach</span>' : ''}</div>
        <div class="deltas"><div><span>Cost</span>${d(o.delta.cost, '$', true)}</div><div><span>Distance</span>${d(o.delta.km, ' km', true)}</div><div><span>Late stops</span>${d(Math.max(0, o.delta.lateStops), '', true)}</div><div><span>Partner</span>${d(o.delta.partner, '', true)}</div></div>
        <ul>${o.actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
        <p class="why">${esc(o.explanation)}</p>
        <div class="row"><button class="btn sm" data-apply="${o.id}">Apply</button><button class="btn sm ghost" data-show="${o.id}">Show on map</button></div>
      </div>`).join('')}</div>
      <div class="grid g2" style="margin-top:16px;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr)">
        <div><div id="map" class="map" style="height:460px"></div><p class="small muted" style="margin-top:6px">Showing option <b>${esc(sel.id)}</b>. Highlighted routes changed; the disrupted route is dashed. Purple rings are stops inserted at ${esc(res.event.timeLabel)}.</p></div>
        <div class="card"><h3>Routes changed by option ${esc(sel.id)}</h3>${changedRoutesTable(sel, plan)}
          <div class="divider"></div><div class="row"><button class="btn ghost sm" id="dlDecision">${ICON.down} Download decision (JSON)</button><a class="btn ghost sm" href="#/api">Call via API →</a></div></div>
      </div>`;
    ensureMap($('#map'));
    const changed = changedRouteIds(sel, plan);
    drawRoutes(Object.assign({}, sel.plan, { tasks: plan.tasks.concat(extraTasks(sel, plan)) }), { highlight: changed.length ? changed : null, time: null });
    $$('[data-show]').forEach((b) => b.addEventListener('click', () => { S.selectedOption = b.dataset.show; renderDisruption(); }));
    $$('[data-apply]').forEach((b) => b.addEventListener('click', () => {
      const o = res.options.find((x) => x.id === b.dataset.apply);
      S.applied[S.date] = { title: `${o.id}. ${o.title}`, event: `${res.event.title || res.event.type} at ${res.event.timeLabel}`, plan: Object.assign({}, o.plan, { decisions: plan.decisions }) };
      S.planView = 'copilot'; S.selectedRoute = changed[0] || null;
      location.hash = '#/plan';
    }));
    $('#dlDecision').addEventListener('click', () => {
      const payload = { date: S.date, event: res.event, recommended: res.recommended, rationale: res.rationale, chosen: sel.id, options: res.options.map((o) => ({ id: o.id, title: o.title, actions: o.actions, explanation: o.explanation, delta: o.delta, feasible: o.feasible })) };
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
      a.download = `copilot-disruption-${S.date}-${res.event.type}.json`; a.click();
    });
  }
  function extraTasks(opt, plan) {
    // synthetic stops (transfer, retry, hot order) are not in the day's task list: place them from their coordinates
    const known = new Set(plan.tasks.map((t) => t.id));
    const extra = [];
    for (const r of opt.plan.routes) for (const s of r.stops) {
      if (s.depot || known.has(s.id)) continue;
      const base = plan.tasks.find((t) => s.id.startsWith(t.id));
      if (s.id.startsWith('XFER')) {
        const br = opt.plan.routes.find((x) => x.broken);
        const last = br && br.stops.filter((z) => !z.depot && z.status === 'done').pop();
        const lt = last && plan.tasks.find((t) => t.id === last.id);
        extra.push({ id: s.id, kind: 'P', orders: ['TRANSFER'], customer: 'Breakdown site', city: 'Breakdown site', lat: lt ? lt.lat : DEPOT.lat, lng: lt ? lt.lng : DEPOT.lng, weight: 0, spots: 0 });
      } else if (base) extra.push(Object.assign({}, base, { id: s.id }));
      else if (s.id.startsWith('HOT')) {
        const src = plan.tasks.find((t) => t.id === (S.scenario.pickup || ''));
        const dst = src && plan.tasks.find((t) => t.id === src.pairedWith);
        const tt = s.id.endsWith('P') ? src : dst;
        if (tt) extra.push(Object.assign({}, tt, { id: s.id, orders: ['HOT ' + tt.orders[0]] }));
      }
    }
    return extra;
  }
  function changedRouteIds(opt, plan) {
    const sig = (r) => r.stops.filter((s) => !s.depot).map((s) => s.id).join(',') + '|' + r.vehicle + '|' + r.driverName + '|' + Math.round((r.end || 0) / 5);
    const base = Object.fromEntries(plan.routes.map((r) => [r.id, sig(r)]));
    return opt.plan.routes.filter((r) => r.broken || base[r.id] !== sig(r)).map((r) => r.id);
  }
  function changedRoutesTable(opt, plan) {
    const ids = changedRouteIds(opt, plan);
    if (!ids.length) return '<p class="muted small">No route changes. This option is handled outside the fleet (partner or next day).</p>';
    const byId = Object.fromEntries(plan.routes.map((r) => [r.id, r]));
    return `<table class="tbl"><thead><tr><th>Route</th><th>Stops</th><th>km</th><th>Ends</th></tr></thead><tbody>${ids.map((id) => {
      const a = byId[id], b = opt.plan.routes.find((r) => r.id === id);
      return `<tr><td><b>${id}</b> ${b.broken ? '<span class="chip crit">OUT</span>' : ''}<div class="small muted">${esc(b.driverName)} · ${esc(b.vehicle)}</div></td><td class="num">${a.nStops} → <b>${b.nStops}</b></td><td class="num">${fmt(a.km)} → <b>${fmt(b.km)}</b></td><td class="num">${hhmm(a.end)} → <b>${hhmm(b.end)}</b></td></tr>`;
    }).join('')}</tbody></table>`;
  }

  // ================================================================== API
  // ------------------------------------------------------------------ driver view (phone) + dispatcher alerts
  const KIND_ICON = {
    traffic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="6" rx="2"/><path d="M5 11l2-5h10l2 5M7 17v2M17 17v2"/></svg>',
    road_closed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M7 12h10"/></svg>',
    hazard: ICON.alert,
    truck: ICON.wrench,
  };
  function driverStopRows(stops, tasks, now, before) {
    const nextIdx = stops.findIndex((s) => !s.depot && s.dep > now);
    return stops.map((s, i) => {
      if (s.depot) return `<li class="${s.dep <= now ? 'done' : ''}"><span class="eta">${hhmm(s.arr)}</span><span class="where"><b>Scarborough terminal</b><span>Reload</span></span><span></span></li>`;
      const t = tasks[s.id] || {};
      const old = before && before[s.id];
      const moved = old != null && Math.abs(old - s.arr) >= 1;
      const cls = s.dep <= now ? 'done' : i === nextIdx ? 'next' : '';
      return `<li class="${cls}"><span class="eta">${moved ? `<s>${hhmm(old)}</s>` : ''}${hhmm(s.arr)}</span>
        <span class="where"><b>${esc(t.city || t.address || s.id)}</b><span>${t.kind === 'P' ? 'Pickup' : t.kind === 'M' ? 'Pickup + delivery' : 'Delivery'} · ${esc(t.customer || '')}${t.hardLatest != null ? ' · appointment' : ''}</span></span>
        <span>${cls === 'done' ? '<span class="chip grey">Done</span>' : cls === 'next' ? '<span class="chip">Next</span>' : s.late > 0 ? `<span class="chip warn">+${s.late} min</span>` : ''}</span></li>`;
    }).join('');
  }
  async function viewDriver(token) {
    const plan = await getPlan();
    if (token !== renderToken) return;
    const routes = plan.routes.filter((r) => r.nStops);
    if (!S.driverRoute || !routes.some((r) => r.id === S.driverRoute)) S.driverRoute = (routes.find((r) => r.id === 'R09') || routes[0]).id;
    if (S.driverNow == null) S.driverNow = 600;
    if (!S.driverKinds) S.driverKinds = new Set(['traffic']);
    const picked = Object.keys(KIND_ICON).filter((k) => S.driverKinds.has(k));
    if (!S.driverDelay) S.driverDelay = 45;
    const r = routes.find((x) => x.id === S.driverRoute);
    const tasks = Object.fromEntries(plan.tasks.map((t) => [t.id, t]));
    const sent = S.driverSent && S.driverSent.route === r.id && S.driverSent.date === S.date ? S.driverSent : null;
    let afterStops = null, before = null, newRoute = null;
    if (sent) {
      const opt = sent.result.options.find((o) => o.id === sent.result.recommended);
      newRoute = opt && opt.plan.routes.find((x) => x.id === r.id);
      if (newRoute && !newRoute.broken && newRoute.stops.length) { afterStops = newRoute.stops; before = Object.fromEntries(r.stops.filter((s) => !s.depot).map((s) => [s.id, s.arr])); }
    }
    const kinds = Object.keys(KIND_ICON);
    const labels = { traffic: 'Heavy traffic', road_closed: 'Road closed', hazard: 'Hazardous conditions', truck: 'Truck problem' };
    $('#view').innerHTML = `
      <div class="page-head"><div><div class="eyebrow">Driver view · ${esc(S.date)}</div><h1>My route today</h1>
        <p>What the driver sees on their phone. When something goes wrong on the road, one tap tells dispatch, and the copilot re-plans the rest of the day.</p></div></div>
      <div class="drv">
        <div class="card" style="margin-bottom:14px"><div class="params">
          <label class="field">Driver<select id="dRoute">${routes.map((x) => `<option value="${x.id}" ${x.id === r.id ? 'selected' : ''}>${x.id} · ${esc(x.driverName)}</option>`).join('')}</select></label>
          <label class="field">Time now <span id="dNowLbl" style="text-transform:none;color:var(--ink);font-size:14px">${hhmm(S.driverNow)}</span><input type="range" id="dNow" min="360" max="1080" step="5" value="${S.driverNow}" /></label>
        </div></div>
        <div class="card" style="margin-bottom:14px">
          <div class="who"><h2>${esc(r.driverName)}</h2><span class="muted small">${esc(r.vehicle)} · ${esc(r.vehicleLabel)} · ends ${hhmm((afterStops ? newRoute : r).end)}</span></div>
          ${sent ? `<p class="small" style="margin:8px 0 0"><b>Updated by dispatch at ${esc(sent.timeLabel)}.</b> ${newRoute && newRoute.broken ? 'This truck is out of service. Help is on the way: stay with the truck.' : 'Struck-through times are the old ETAs.'}</p>` : ''}
          <ul class="drv-stops" style="margin-top:8px">${driverStopRows(afterStops || r.stops, tasks, S.driverNow, before)}</ul>
        </div>
        ${sent ? `<div class="card sent" style="margin-bottom:14px"><h3 style="margin-top:0">Dispatch has your report</h3>
            <p class="small" style="margin:0 0 6px">${esc(sent.description)}</p>
            <p class="small" style="margin:0"><b>Dispatch plan:</b> ${esc(sent.recommendation)}</p>
            <div class="row" style="margin-top:10px"><button class="btn ghost sm" id="dNew">Report something else</button></div></div>`
        : `<div class="card"><h3 style="margin-top:0">Report a problem</h3>
            <p class="small muted" style="margin:-4px 0 10px">Tap everything that applies.</p>
            <div class="report-kinds" role="group" aria-label="Problem types, pick one or more">${kinds.map((k) => `<button data-kind="${k}" class="${S.driverKinds.has(k) ? 'on' : ''}" aria-pressed="${S.driverKinds.has(k)}">${S.driverKinds.has(k) ? '<span class="tick" aria-hidden="true">✓</span>' : ''}${KIND_ICON[k]}${labels[k]}</button>`).join('')}</div>
            ${!picked.length ? '<p class="small muted" style="margin:14px 0 0">Pick at least one problem.</p>'
              : picked.includes('truck') ? `<p class="small muted" style="margin:14px 0 0">The truck cannot continue${picked.length > 1 ? ', so the road conditions are passed on with it' : ''}: dispatch will send help and move your remaining stops.</p>`
              : `<p class="field" style="margin:14px 0 6px">How far behind are you${picked.length > 1 ? ' in total' : ''}?</p><div class="delay-pick" role="group" aria-label="Delay">${[15, 30, 45, 60, 90].map((m) => `<button data-delay="${m}" class="${S.driverDelay === m ? 'on' : ''}" aria-pressed="${S.driverDelay === m}">${m} min</button>`).join('')}</div>`}
            <div style="margin-top:16px"><button class="btn big" id="dSend" ${picked.length ? '' : 'disabled'}>Send to dispatch${picked.length > 1 ? ` (${picked.length} problems)` : ''}</button></div>
            <p class="small muted" id="dMsg" style="margin:8px 0 0"></p></div>`}
      </div>`;
    $('#dRoute').addEventListener('change', (e) => { S.driverRoute = e.target.value; route(); });
    $('#dNow').addEventListener('input', (e) => { S.driverNow = Number(e.target.value); $('#dNowLbl').textContent = hhmm(S.driverNow); });
    $('#dNow').addEventListener('change', () => route());
    $$('[data-kind]').forEach((b) => b.addEventListener('click', () => { const k = b.dataset.kind; if (S.driverKinds.has(k)) S.driverKinds.delete(k); else S.driverKinds.add(k); route(); }));
    $$('[data-delay]').forEach((b) => b.addEventListener('click', () => { S.driverDelay = Number(b.dataset.delay); route(); }));
    const nb = $('#dNew'); if (nb) nb.addEventListener('click', () => { S.driverSent = null; route(); });
    const sb = $('#dSend');
    if (sb) sb.addEventListener('click', async () => {
      sb.disabled = true; $('#dMsg').textContent = 'Sending…';
      try {
        const res = await Data.post('reports/' + S.date, { route: r.id, kinds: picked, kind: picked[0], delayMin: S.driverDelay, time: S.driverNow });
        S.driverSent = res;
        Alerts.poll();
        route();
      } catch (err) { $('#dMsg').textContent = 'Could not send: ' + err.message; sb.disabled = false; }
    });
  }
  // dispatcher side: new driver reports pop up on every page except the driver view
  const Alerts = {
    seen: new Set(), list: [], timer: null,
    async poll() {
      if (!S.date) return;
      try {
        const res = await Data.get('reports/' + S.date);
        this.list = res.reports || [];
      } catch (e) { return; }
      this.render();
    },
    render() {
      let box = $('#alerts');
      if (!box) { box = document.createElement('div'); box.id = 'alerts'; box.className = 'alerts'; box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
      const onDriver = (location.hash.replace(/^#\/?/, '').split('?')[0]) === 'driver';
      const show = onDriver ? [] : this.list.filter((r) => !this.seen.has(r.id)).slice(0, 3);
      box.innerHTML = show.map((r) => `<div class="alert-card" role="alert"><div class="t">${KIND_ICON[r.kind] || ICON.alert}${esc(r.label)} on ${esc(r.route)} · ${esc(r.timeLabel)}</div>
        <p>${esc(r.description)}</p><p class="rec">Recommended: <b>${esc(r.recommendation)}</b></p>
        <div class="row"><button class="btn sm" data-review="${r.id}">Review options</button><button class="btn ghost sm" data-dismiss="${r.id}">Dismiss</button></div></div>`).join('');
      $$('[data-review]', box).forEach((b) => b.addEventListener('click', () => this.review(b.dataset.review)));
      $$('[data-dismiss]', box).forEach((b) => b.addEventListener('click', async () => { this.seen.add(b.dataset.dismiss); this.render(); try { await Data.del(`reports/${S.date}/${b.dataset.dismiss}`); } catch (e) { /* already gone */ } }));
    },
    async review(id) {
      this.seen.add(id); this.render();
      const rep = await Data.get(`reports/${S.date}/${id}`);
      const ev = rep.result.event;
      S.scenario = Object.assign({ date: S.date }, ev);
      S.disruption = Object.assign({}, rep.result, { ms: 0 });
      S.selectedOption = rep.result.recommended;
      if (location.hash === '#/adapt') route(); else location.hash = '#/adapt';
    },
    start() { this.poll(); if (!this.timer) this.timer = setInterval(() => this.poll(), 8000); window.addEventListener('hashchange', () => this.render()); },
  };

  async function viewApi() {
    const base = location.origin + location.pathname.replace(/index\.html$/, '');
    // the calls people actually try, in plain words; the rest sit under "Show all endpoints"
    const main = [
      ['GET', `plan/${S.date}`, 'Today\'s plan', 'Every route, stop, ETA and load plan the copilot recommends'],
      ['GET', `plan/${S.date}/compare`, 'Copilot vs as dispatched', 'The headline numbers for the day, side by side'],
      ['GET', `conflicts/${S.date}?plan=manual`, 'Problems in George\'s plan', 'Overloads, missed appointments, hours-of-service breaches'],
      ['GET', `decisions/${S.date}`, 'Decision log', 'Every decision the copilot made, with its reason'],
      ['POST', `disruptions/${S.date}`, 'A truck breaks down', 'Ranked recovery options, each with cost and late stops'],
      ['GET', `plans/${S.date}`, 'All plans for the day', 'Copilot, as dispatched and any custom plans, with their numbers'],
    ];
    const more = [
      ['GET', 'health', 'Is the service up, and which days are loaded (no key needed)'],
      ['GET', 'summary', 'Copilot vs as dispatched across all 10 days'],
      ['GET', `plan/${S.date}/routes/R01`, 'One route as a driver would receive it'],
      ['GET', `export/${S.date}?format=csv`, 'The dispatch file (first 25 lines)'],
      ['POST', `plans/${S.date}`, 'Build a custom plan ("Use the whole fleet")'],
      ['GET', `fleet/${S.date}`, 'Drivers, vehicles and plan settings available'],
      ['GET', `scenarios/${S.date}`, 'The ready-made disruption scenarios'],
      ['GET', `events/${S.date}`, 'The simulated road & weather events for the day'],
      ['GET', 'assumptions', 'Every modelling assumption (no key needed)'],
      ['GET', 'openapi.json', 'The technical API description (no key needed)'],
    ];
    const row = ([m, p, title, desc]) => `<div class="endpoint"><span class="method ${m === 'POST' ? 'post' : ''}">${m}</span><div><b>${esc(title)}</b><div class="d">${desc ? esc(desc) + ' · ' : ''}<code>/api/v1/${esc(p)}</code></div></div><button class="btn sm ghost" data-try="${m} ${esc(p)}">Try</button></div>`;
    const faq = (q, a, open) => `<details class="faq"${open ? ' open' : ''}><summary>${q}</summary><div class="faq-body">${a}</div></details>`;
    return `
      <div class="page-head"><div><div class="eyebrow">Connect</div><h1>API &amp; exports</h1><p>Download what the copilot worked out, or let another system pull it automatically. ${Data.mode === 'local' ? '<b>Offline mode:</b> the server is not running, so calls below run in the browser.' : ''}</p></div></div>
      <div class="card" style="margin-bottom:16px">
        <h3>Download for ${esc(S.date)}</h3>
        <div class="dl-grid">
          <a class="dl" href="api/v1/export/${S.date}?format=csv&api_key=${API_KEY}">${ICON.down}<span><b>Dispatch file (CSV)</b><span>One row per stop: route, driver, ETA, load order. Opens in Excel; ready for Samsara or the dock.</span></span></a>
          <a class="dl" href="api/v1/decisions/${S.date}?format=csv&api_key=${API_KEY}">${ICON.down}<span><b>Decision log (CSV)</b><span>Every decision the copilot made today, with the reason.</span></span></a>
          <a class="dl" href="api/v1/export/${S.date}?format=json&api_key=${API_KEY}">${ICON.down}<span><b>Dispatch file (JSON)</b><span>The same rows, for another system to read.</span></span></a>
        </div>
        <p class="small muted" style="margin-top:10px">These are for the copilot plan. To download George's plan or a custom plan, use the buttons on Plan the Day.</p>
      </div>
      <div class="grid g2">
        <div class="card">
          <h3>Try it live</h3>
          <p class="small muted" style="margin:0 0 4px">Each button calls the real API and shows the answer on the right.</p>
          ${main.map(row).join('')}
          <details class="more-eps"><summary>Show all endpoints (${more.length} more)</summary>${more.map(([m, p, d]) => row([m, p, d, ''])).join('')}</details>
        </div>
        <div class="card"><h3>Response</h3><div class="muted small" id="tryLabel" style="margin-bottom:8px">Press “Try” on any call.</div><pre class="code" id="tryOut">{ }</pre></div>
      </div>
      <div class="section" style="margin-top:24px">
        <h2 style="font-size:18px;margin-bottom:10px">Questions about the API</h2>
        ${faq('How do I connect another system?', `<p>Use this address and send the key with every call:</p>
          <div class="keybox">Address <code>${esc(base)}api/v1/</code></div>
          <div class="keybox" style="margin-top:8px">Key <code>X-API-Key: ${API_KEY}</code> <span class="muted small">(a demo key; it also works as <code>?api_key=</code> in a link)</span></div>`)}
        ${faq('How do I call it from a terminal?', `<pre class="code"><span class="k"># Today's recommended plan</span>
curl -H "X-API-Key: ${API_KEY}" \\
  ${esc(base)}api/v1/plan/${S.date}

<span class="k"># A truck broke down at 09:18: what now?</span>
curl -X POST -H "X-API-Key: ${API_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"type":"breakdown","time":558}' \\
  ${esc(base)}api/v1/disruptions/${S.date}

<span class="k"># Build a custom plan that uses the whole fleet</span>
curl -X POST -H "X-API-Key: ${API_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Whole fleet","settings":{"objective":"balanced","maxDutyHours":12}}' \\
  ${esc(base)}api/v1/plans/${S.date}</pre>`)}
        ${faq('How do I use it from Python or a BI tool?', `<pre class="code">import requests
r = requests.get("${esc(base)}api/v1/decisions/${S.date}",
                 headers={"X-API-Key": "${API_KEY}"})
for d in r.json()["decisions"]:
    print(d["timeLabel"], d["decision"], d["reason"])</pre>
          <p class="small muted" style="margin-top:8px">Power BI and Excel can read the CSV download links directly.</p>`)}
        ${faq('How would it fit with Elite TMS and Samsara?', `<ol class="small" style="padding-left:18px;margin:0;line-height:1.7">
            <li><b>05:30</b>: pull orders from ${ELITE}, and drivers and hours from ${SAMSARA}</li>
            <li><b>06:00</b>: the copilot plans the day; George reviews and approves it here</li>
            <li><b>06:30</b>: approved routes go to the drivers' Samsara app; the dock prints load sheets from the dispatch file</li>
            <li><b>All day</b>: each new Elite order is inserted live; disruptions and driver reports come with recovery options for George</li>
            <li><b>Evening</b>: the decision log and the day's comparison feed the KPI review</li></ol>`)}
        ${faq('Can I get George\'s plan or a custom plan instead?', `<p class="small">Yes. Add <code>?plan=manual</code> for George's plan, or <code>?plan=</code> followed by a custom plan's id, to the dispatch file, decision log and problems calls. The <b>Dispatch file</b> and <b>Save log</b> buttons on Plan the Day do this for whichever plan is open.</p>`)}
        ${faq('Where is the full technical reference?', `<p class="small">The <a href="api/v1/openapi.json" target="_blank">OpenAPI description</a> lists every endpoint, including the driver-report calls used by the Driver view (<code>/api/v1/reports/{date}</code>).</p>`)}
        ${faq('Is this secure enough for production?', `<p class="small">Not yet: the demo uses one shared key. In production each system and user gets its own key or single sign-on, all traffic runs over HTTPS, and every call is logged.</p>`)}
      </div>`;
  }
  viewApi.after = function () {
    $$('[data-try]').forEach((b) => b.addEventListener('click', async () => {
      const [m, p] = b.dataset.try.split(' ');
      $('#tryLabel').textContent = `${m} /api/v1/${p}`;
      $('#tryOut').textContent = 'Loading…';
      const t0 = performance.now();
      try {
        let out;
        if (p.startsWith('export/')) {
          const r = await fetch('api/v1/' + p, { headers: { 'X-API-Key': API_KEY } });
          out = (await r.text()).split('\n').slice(0, 25).join('\n') + '\n…';
          $('#tryOut').textContent = out;
        } else {
          out = m === 'POST' && p.startsWith('plans/') ? await Data.post(p, { name: 'API demo: whole fleet', base: 'optimise', settings: { objective: 'balanced' } }).then((x) => { invalidatePlans(); return { planId: x.planId, custom: x.custom, kpis: x.kpis, fleet: x.fleet }; })
            : m === 'POST' ? await Data.post(p + '?compact=1', { type: 'breakdown' }) : await (p === 'health' || p === 'openapi.json' ? fetch('api/v1/' + p).then((r) => r.json()) : Data.get(p));
          if (m === 'POST' && out.options) out.options.forEach((o) => delete o.plan);
          let txt = JSON.stringify(out, null, 2);
          if (txt.length > 60000) txt = txt.slice(0, 60000) + '\n… (truncated for display)';
          $('#tryOut').textContent = txt;
        }
        $('#tryLabel').textContent += ` · ${Math.round(performance.now() - t0)} ms`;
      } catch (e) { $('#tryOut').textContent = 'Error: ' + e.message; }
    }));
  };

  // ================================================================== ASSUMPTIONS
  async function viewAssumptions() {
    const [a, plan, cmp] = await Promise.all([getAssumptions(), getPlan(), getCompare()]);
    const logKm = cmp.actual && cmp.actual.logbookKm;
    const learned = plan.tasks.filter((t) => t.svcSource === 'history');
    const svcMed = (() => { const v = learned.map((t) => t.serviceMin).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : 0; })();
    const est = (k) => plan.tasks.filter((t) => t.estimated.includes(k)).length;
    return `
      <div class="page-head"><div><div class="eyebrow">Data transparency</div><h1>What is real, what is estimated, and why</h1><p>The copilot never hides a guess. Each estimated value is tagged <span class="chip est">EST</span> in the plan, and every modelling assumption is listed here and served by <code>/api/v1/assumptions</code>.</p></div></div>
      <div class="grid g4" style="margin-bottom:16px">
        <div class="card stat-tile"><b>${plan.tasks.length}</b><span>customer stops on ${esc(S.date)}</span></div>
        <div class="card stat-tile"><b>${est('skid_spots')}</b><span>without skid-spot counts → estimated from weight and piece type</span></div>
        <div class="card stat-tile"><b>${est('weight')}</b><span>with no usable weight → 150 lb per piece</span></div>
        <div class="card stat-tile"><b>${est('appointment_time')}</b><span>flagged APPOINT with no time → treated as no window</span></div>
      </div>
      <div class="grid g2">
        <div class="card"><h3>Modelling assumptions</h3><table class="tbl"><tbody>${Object.entries(a.assumptions).map(([k, v]) => `<tr><td style="width:150px"><b>${esc(k)}</b></td><td><div><b>${esc(v.value)}</b></div><div class="small muted">${esc(v.text)}</div></td></tr>`).join('')}</tbody></table></div>
        <div>
          <div class="card" style="margin-bottom:16px"><h3>Stop times learned from history, ${esc(S.date)}</h3>
            <p class="small" style="margin:0 0 6px"><b>${learned.length} of ${plan.tasks.length}</b> stops use the median time this customer actually took on other days in ${SAMSARA} GPS data (median ${fmt(svcMed)} min). The other ${plan.tasks.length - learned.length} customers had no visit on another day, so they use the 15 min + extras rule.</p>
            <p class="small muted" style="margin:0">Both plans use the same stop times, so the comparison stays fair, and routes are sized for how long stops really take.</p></div>
          ${logKm ? `<div class="card" style="margin-bottom:16px"><h3>Distance reality check, ${esc(S.date)}</h3><table class="tbl"><tbody>
            <tr><td>Trucks' own logbooks (${SAMSARA} ELD, every km driven)</td><td class="num"><b>${fmt(logKm)} km</b></td></tr>
            <tr><td>Our model of George's plan</td><td class="num">${fmt(cmp.manual.km)} km</td></tr>
            <tr><td>Copilot plan, same model</td><td class="num">${fmt(cmp.copilot.km)} km</td></tr>
            <tr><td>GPS inside Samsara routes only</td><td class="num muted">${fmt(cmp.actual.gpsKm)} km</td></tr></tbody></table>
            <p class="small muted" style="margin:8px 0 0">The model estimates George's plan ${fmt(Math.abs(Math.round(((cmp.manual.km - logKm) / logKm) * 100)))}% ${cmp.manual.km <= logKm ? 'below' : 'above'} what the logbooks recorded, so the savings shown are conservative. Route GPS is lower because it only counts driving inside Samsara routes, not every trip a truck made that day.</p></div>` : ''}
          <div class="card"><h3>Vehicle classes</h3><table class="tbl"><thead><tr><th>Class</th><th>Payload</th><th>Floor</th><th>Licence</th><th>$/km</th></tr></thead><tbody>${Object.values(a.vehicles).map((v) => `<tr><td><b>${esc(v.label)}</b></td><td class="num">${fmt(v.maxLb)} lb</td><td class="num">${v.spots} spots</td><td>${esc(v.licence.join('/'))}</td><td class="num">$${v.costKm}</td></tr>`).join('')}</tbody></table></div>
          <div class="card" style="margin-top:16px"><h3>Straight from the data</h3><ul class="small" style="padding-left:18px;margin:0;line-height:1.7">
            <li>Orders, legs, addresses, coordinates, weights, pieces, services, equipment and handling flags: Elite TMS (ORDERTRAIL)</li>
            <li>Dispatch timestamps (when George assigned each leg): Elite export files</li>
            <li>Actual arrivals, departures and visit order: Samsara GPS geofences</li>
            <li>Drivers, vehicles and HOS hours: Samsara vehicle log and ELD</li>
            <li>Customer names are pseudonymised CUST- codes. Addresses and order numbers are real.</li></ul></div>
          <div class="card" style="margin-top:16px"><h3>Simplifications for the prototype</h3><ul class="small" style="padding-left:18px;margin:0;line-height:1.7">
            <li>One terminal (Scarborough); every route starts and ends there. Mid-day reloads are allowed.</li>
            <li>Road distance and drive time are modelled, not routed. Production would call Google Routes or Samsara.</li>
            <li>No cubic volume in Elite; floor space uses skid spots (estimated when blank).</li>
            <li>Pickup → delivery pairs on the same day stay on one truck. Other pickups return to the terminal for cross-dock.</li>
            <li>Partner rates are indicative, not contracted rates.</li></ul></div>
        </div>
      </div>`;
  }

  // ------------------------------------------------------------------ boot
  async function boot() {
    const h = await Data.init();
    Health.paint();
    Health.start();
    setTimeout(() => Alerts.start(), 0);
    S.dates = h.dates;
    S.date = h.defaultDate;
    const sel = $('#dateSelect');
    sel.innerHTML = h.dates.map((d) => `<option value="${d}" ${d === S.date ? 'selected' : ''}>${new Date(d + 'T12:00').toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' })}</option>`).join('');
    const evBtn = $('#evToggle');
    const paintEv = () => { evBtn.classList.toggle('on', S.events); evBtn.setAttribute('aria-pressed', S.events); evBtn.querySelector('span').textContent = `Road & weather: ${S.events ? 'On' : 'Off'}`; };
    window.toggleEvents = () => { S.events = !S.events; paintEv(); stopReplay(); S.selectedRoute = null; S.disruption = null; S.scenario = null; S.replayT = null; S.applied = {}; route(); toast(S.events ? '<b>Simulated road &amp; weather events on.</b> Plans now include closures, construction, weather, event traffic and accidents.' : 'Simulated events off.', 'good'); };
    evBtn.addEventListener('click', () => window.toggleEvents());
    document.addEventListener('click', (e) => { if (e.target.closest('[data-ev-toggle]')) window.toggleEvents(); });
    paintEv();
    sel.addEventListener('change', () => { S.date = sel.value; S.selectedRoute = null; S.disruption = null; S.scenario = null; S.replayT = null; route(); });
    window.addEventListener('hashchange', route);
    document.addEventListener('change', onMoveSelect);
    route();
  }
  boot();
})();
