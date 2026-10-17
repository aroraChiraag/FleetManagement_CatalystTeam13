/*
 * Dispatch Copilot — demo server (zero dependencies, Node 18+).
 *   node server.js            -> http://localhost:8080
 * Serves the web app from /public and the REST API under /api/v1.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const E = require('./engine/engine.js');

const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.API_KEY || 'toe-demo-2026';
const ROOT = __dirname;
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'dataset.json'), 'utf8'));
const DATES = Object.keys(DATA.days).sort();
const DEFAULT_DATE = DATES.includes('2026-09-22') ? '2026-09-22' : DATES[0];

// ------------------------------------------------------------------ cached computations
const cache = new Map();
function memo(key, fn) {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
}
const dayOf = (date) => DATA.days[date];
const planOf = (date) => memo('plan:' + date, () => E.planDay(dayOf(date), { dynamic: true }));
const manualOf = (date) => memo('manual:' + date, () => E.manualPlan(dayOf(date)));
const scenariosOf = (date) => memo('scen:' + date, () => E.scenarioCatalog(planOf(date), dayOf(date)));

// ------------------------------------------------------------------ custom plans (saved as recipes, rebuilt on demand)
const CUSTOM_FILE = path.join(ROOT, 'data', 'custom-plans.json');
let recipes = [];
try { recipes = JSON.parse(fs.readFileSync(CUSTOM_FILE, 'utf8')); } catch (e) { recipes = []; }
const saveRecipes = () => fs.writeFile(CUSTOM_FILE, JSON.stringify(recipes, null, 2), (e) => e && console.error('could not save custom plans', e.message));
const customPlans = new Map();
const notFound = (msg) => Object.assign(new Error(msg), { status: 404 });
function recipeOf(date, id) {
  const r = recipes.find((x) => x.id === id && x.date === date);
  if (!r) throw notFound(`No plan "${id}" on ${date}. Use copilot, manual or a custom plan id from GET /api/v1/plans/${date}.`);
  return r;
}
function customOf(date, id) {
  const r = recipeOf(date, id);
  if (!customPlans.has(id)) customPlans.set(id, E.buildCustomPlan(dayOf(date), r));
  return customPlans.get(id);
}
function anyPlan(date, id) {
  if (!id || id === 'copilot') return planOf(date);
  if (id === 'manual') return manualOf(date);
  return customOf(date, id);
}
function planMeta(date, id) {
  const p = anyPlan(date, id);
  const base = { id, kpis: p.kpis, fleet: p.fleet };
  if (id === 'copilot') return Object.assign(base, { kind: 'default', name: 'Copilot plan', description: 'Lowest total cost, live replay of call-ins, whole fleet available.' });
  if (id === 'manual') return Object.assign(base, { kind: 'default', name: 'As dispatched', description: 'What George actually did, rebuilt from GPS and re-costed with the same model.' });
  const r = recipeOf(date, id);
  return Object.assign(base, { kind: 'custom', name: r.name, base: r.base, settings: p.custom.settings, objective: p.custom.objective, moves: r.moves.length, created: r.created });
}
function publicCustom(date, id) {
  const out = E.publicPlan(anyPlan(date, id));
  out.planId = id;
  return out;
}
const conflictsOf = (date, which) => {
  if (which === 'copilot' || which === 'manual') return memo(`conf:${which}:${date}`, () => E.detectConflicts(which === 'manual' ? manualOf(date) : planOf(date), dayOf(date), which));
  return E.detectConflicts(anyPlan(date, which), dayOf(date), recipeOf(date, which).base === 'manual' ? 'manual' : 'custom');
};

function compareOf(date) {
  return memo('cmp:' + date, () => {
    const p = planOf(date), m = manualOf(date);
    return {
      date, weekday: dayOf(date).weekday,
      copilot: p.kpis, manual: m.kpis, actual: dayOf(date).actualSummary, morning: p.morningKpis,
      liveInsertions: p.live.length,
      conflicts: { copilot: countSev(conflictsOf(date, 'copilot')), manual: countSev(conflictsOf(date, 'manual')) },
    };
  });
}
function countSev(list) {
  return list.reduce((a, c) => ((a[c.severity] = (a[c.severity] || 0) + 1), a), { critical: 0, warning: 0, info: 0 });
}
function summaryAll() {
  return memo('summary', () => {
    const days = DATES.map(compareOf);
    const sum = (f) => days.reduce((a, d) => a + f(d), 0);
    const pct = (a, b) => Math.round(((a - b) / b) * 1000) / 10;
    const c = { km: sum((d) => d.copilot.km), cost: sum((d) => d.copilot.totalCost), trucks: sum((d) => d.copilot.trucksUsed), late: sum((d) => d.copilot.lateStops), stops: sum((d) => d.copilot.stopsRouted), duty: sum((d) => d.copilot.dutyHours), co2: sum((d) => d.copilot.co2kg) };
    const m = { km: sum((d) => d.manual.km), cost: sum((d) => d.manual.totalCost), trucks: sum((d) => d.manual.trucksUsed), late: sum((d) => d.manual.lateStops), stops: sum((d) => d.manual.stopsRouted), duty: sum((d) => d.manual.dutyHours), co2: sum((d) => d.manual.co2kg) };
    // how each vehicle class was used, summed over all days
    const mix = (which) => {
      const rows = {};
      for (const d of DATES) for (const f of (which === 'copilot' ? planOf(d) : manualOf(d)).fleet) {
        const r = (rows[f.cls] = rows[f.cls] || { cls: f.cls, short: f.short, label: f.label, available: 0, used: 0, stops: 0, utilSpotsSum: 0, utilLbSum: 0, small: 0, tractorOnly: 0, heavy: 0, overloads: 0, mismatches: 0 });
        r.available += f.available; r.used += f.used; r.stops += f.stops; r.utilSpotsSum += f.utilSpots * f.used; r.utilLbSum += f.utilLb * f.used;
        r.small += f.small; r.tractorOnly += f.tractorOnly; r.heavy += f.heavy; r.overloads += f.overloads; r.mismatches += f.mismatches;
      }
      return Object.values(rows).map((r) => ({ cls: r.cls, short: r.short, label: r.label, usedPerDay: Math.round((r.used / days.length) * 10) / 10, availablePerDay: Math.round((r.available / days.length) * 10) / 10, stopsPerTruck: r.used ? Math.round((r.stops / r.used) * 10) / 10 : 0, utilSpots: r.used ? Math.round(r.utilSpotsSum / r.used) : 0, utilLb: r.used ? Math.round(r.utilLbSum / r.used) : 0, small: r.small, tractorOnly: r.tractorOnly, heavy: r.heavy, overloads: r.overloads, mismatches: r.mismatches }));
    };
    const avg = (f) => Math.round(sum(f) / days.length);
    return {
      period: DATA.meta.period, days: days.length, history: DATA.history,
      copilot: c, manual: m,
      deltas: {
        kmPct: pct(c.km, m.km), costPct: pct(c.cost, m.cost), trucksPct: pct(c.trucks, m.trucks), dutyPct: pct(c.duty, m.duty),
        onTimeCopilot: Math.round(((c.stops - c.late) / c.stops) * 1000) / 10,
        onTimeManual: Math.round(((m.stops - m.late) / m.stops) * 1000) / 10,
        kmSaved: m.km - c.km, costSaved: m.cost - c.cost, co2Saved: m.co2 - c.co2,
        trucksFreedPerDay: Math.round(((m.trucks - c.trucks) / days.length) * 10) / 10,
        utilSpotsCopilot: avg((d) => d.copilot.avgUtilSpots), utilSpotsManual: avg((d) => d.manual.avgUtilSpots),
        utilLbCopilot: avg((d) => d.copilot.avgUtilLb), utilLbManual: avg((d) => d.manual.avgUtilLb),
        stopsPerTruckCopilot: Math.round((c.stops / c.trucks) * 10) / 10, stopsPerTruckManual: Math.round((m.stops / m.trucks) * 10) / 10,
        overloadsManual: sum((d) => d.manual.overloadedTrucks), overloadsCopilot: sum((d) => d.copilot.overloadedTrucks),
        mismatchesManual: sum((d) => d.manual.equipmentMismatches), mismatchesCopilot: sum((d) => d.copilot.equipmentMismatches),
      },
      fleetMix: { copilot: mix('copilot'), manual: mix('manual') },
      lateDispatchedPct: Math.round((sum((d) => d.actual.lateDispatched) / sum((d) => d.manual.stopsRouted)) * 100),
      perDay: days.map((d) => ({ date: d.date, weekday: d.weekday, copilot: pick(d.copilot), manual: pick(d.manual), actual: d.actual })),
    };
  });
}
const pick = (k) => ({ trucksAvailable: k.trucksAvailable, avgUtilSpots: k.avgUtilSpots, trucksUsed: k.trucksUsed, km: k.km, onTimePct: k.onTimePct, totalCost: k.totalCost, dutyHours: k.dutyHours, lateStops: k.lateStops, partnerShipments: k.partnerShipments });

// ------------------------------------------------------------------ http helpers
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function send(res, status, body, headers) {
  const h = Object.assign({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-API-Key', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' }, headers || {});
  if (typeof body === 'object' && !Buffer.isBuffer(body)) { body = JSON.stringify(body); h['Content-Type'] = h['Content-Type'] || 'application/json; charset=utf-8'; }
  res.writeHead(status, h);
  res.end(body);
}
const err = (res, status, message, extra) => send(res, status, Object.assign({ error: message }, extra || {}));
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}
function serveStatic(res, rel) {
  const base = rel.startsWith('/engine/') || rel.startsWith('/data/') ? ROOT : path.join(ROOT, 'public');
  const file = path.normalize(path.join(base, rel === '/' ? 'index.html' : rel));
  if (!file.startsWith(base)) return err(res, 403, 'forbidden');
  fs.readFile(file, (e, buf) => {
    if (e) return err(res, 404, 'not found');
    send(res, 200, buf, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  });
}
function download(res, name, body, type) {
  send(res, 200, body, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"` });
}

// ------------------------------------------------------------------ API
const routes = [];
const api = (method, pattern, handler, opts) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, open: opts && opts.open, doc: opts && opts.doc });

function needDate(params) {
  const d = params.date === 'today' || params.date === 'default' ? DEFAULT_DATE : params.date;
  if (!DATA.days[d]) { const e = new Error(`Unknown date ${params.date}. Available: ${DATES.join(', ')}`); e.status = 404; throw e; }
  return d;
}

api('GET', '/api/v1/health', () => ({ status: 'ok', service: 'dispatch-copilot', version: '1.0.0-demo', dataset: DATA.meta, dates: DATES, defaultDate: DEFAULT_DATE }), { open: true });
api('GET', '/api/v1/openapi.json', () => openapi(), { open: true });
api('GET', '/api/v1/assumptions', () => ({ assumptions: E.ASSUMPTIONS, vehicles: E.VEHICLES }), { open: true });
api('GET', '/api/v1/days', () => ({ defaultDate: DEFAULT_DATE, days: DATES.map((d) => ({ date: d, weekday: DATA.days[d].weekday, tasks: DATA.days[d].tasks.length, drivers: DATA.days[d].drivers.length, actual: DATA.days[d].actualSummary })) }));
api('GET', '/api/v1/summary', () => summaryAll());
api('GET', '/api/v1/plan/:date', (p, q) => {
  const d = needDate(p);
  const plan = E.publicPlan(planOf(d));
  if (q.fields === 'kpis') return { date: d, kpis: plan.kpis };
  return plan;
});
api('GET', '/api/v1/plan/:date/manual', (p) => {
  const d = needDate(p);
  return E.publicPlan(manualOf(d));
});
api('GET', '/api/v1/plan/:date/compare', (p) => compareOf(needDate(p)));
api('GET', '/api/v1/plan/:date/routes/:route', (p) => {
  const d = needDate(p);
  const r = planOf(d).routes.find((x) => x.id === p.route);
  if (!r) { const e = new Error('Unknown route'); e.status = 404; throw e; }
  return Object.assign({ date: d, decisions: planOf(d).decisions.filter((x) => x.route === r.id) }, r);
});
api('GET', '/api/v1/conflicts/:date', (p, q) => {
  const d = needDate(p);
  const which = q.plan || 'copilot';
  if (which !== 'copilot' && which !== 'manual') recipeOf(d, which);
  const list = conflictsOf(d, which);
  return { date: d, plan: which, counts: countSev(list), conflicts: list };
});
api('GET', '/api/v1/decisions/:date', (p, q, req, res) => {
  const d = needDate(p);
  const list = (anyPlan(d, q.plan).decisions || []).map((x) => Object.assign({ date: d, timeLabel: x.time == null ? 'edit' : E.hhmm(x.time) }, x));
  if (q.format === 'csv') return download(res, `copilot-decisions-${d}${q.plan ? '-' + q.plan : ''}.csv`, E.toCSV(list.map((x) => ({ date: x.date, seq: x.seq, time: x.timeLabel, type: x.type, subject: x.subject, route: x.route || '', decision: x.decision, reason: x.reason, confidence: x.confidence }))), 'text/csv; charset=utf-8');
  return { date: d, count: list.length, decisions: list };
});
api('GET', '/api/v1/export/:date', (p, q, req, res) => {
  const d = needDate(p);
  const rows = E.toDispatchRows(anyPlan(d, q.plan));
  const tag = q.plan && q.plan !== 'copilot' ? '-' + q.plan : '';
  if (q.format === 'json') return download(res, `copilot-dispatch-${d}${tag}.json`, JSON.stringify({ date: d, generated: new Date().toISOString(), rows }, null, 2), 'application/json');
  return download(res, `copilot-dispatch-${d}${tag}.csv`, E.toCSV(rows), 'text/csv; charset=utf-8');
});
api('GET', '/api/v1/fleet/:date', (p) => {
  const d = needDate(p);
  const day = dayOf(d);
  return {
    date: d,
    drivers: day.drivers.map((x) => ({ code: x.code, name: x.name, vehicle: x.vehicle || null, vehicleClass: x.vehicleClass, vehicleLabel: (E.VEHICLES[x.vehicleClass] || {}).label, licence: x.licence, licenceInferred: true })),
    objectives: E.OBJECTIVES, defaults: E.DEFAULT_SETTINGS,
  };
});
api('GET', '/api/v1/plans/:date', (p) => {
  const d = needDate(p);
  return { date: d, plans: ['copilot', 'manual'].concat(recipes.filter((r) => r.date === d).map((r) => r.id)).map((id) => planMeta(d, id)) };
});
api('POST', '/api/v1/plans/:date', async (p, q, req) => {
  const d = needDate(p);
  const body = await readBody(req);
  const base = ['optimise', 'copilot', 'manual'].includes(body.base) ? body.base : 'optimise';
  const r = { id: 'c' + Date.now().toString(36), date: d, name: String(body.name || 'Custom plan').slice(0, 60), base, settings: base === 'optimise' ? body.settings || {} : {}, moves: [], created: new Date().toISOString() };
  recipes.push(r);
  try { customOf(d, r.id); } catch (e) { recipes = recipes.filter((x) => x !== r); throw e; }
  saveRecipes();
  return publicCustom(d, r.id);
});
api('GET', '/api/v1/plans/:date/:id', (p) => publicCustom(needDate(p), p.id));
api('POST', '/api/v1/plans/:date/:id/moves', async (p, q, req) => {
  const d = needDate(p);
  if (p.id === 'copilot' || p.id === 'manual') throw Object.assign(new Error('Default plans are read-only. Create a custom plan (POST /api/v1/plans/{date} with base "copilot" or "manual") and edit that.'), { status: 400 });
  const r = recipeOf(d, p.id);
  const body = await readBody(req);
  if (!body.task || !body.target) throw Object.assign(new Error('Send {"task": "<stop id>", "target": "<route id> | PARTNER"}'), { status: 400 });
  const res = E.moveStop(customOf(d, p.id), body.task, body.target);
  customPlans.set(p.id, res.plan);
  r.moves.push({ task: body.task, target: body.target });
  saveRecipes();
  return { impact: res.impact, plan: publicCustom(d, p.id) };
});
api('POST', '/api/v1/plans/:date/:id/undo', (p) => {
  const d = needDate(p);
  const r = recipeOf(d, p.id);
  r.moves.pop();
  customPlans.delete(p.id);
  saveRecipes();
  return publicCustom(d, p.id);
});
api('DELETE', '/api/v1/plans/:date/:id', (p) => {
  const d = needDate(p);
  recipeOf(d, p.id);
  recipes = recipes.filter((x) => x.id !== p.id);
  customPlans.delete(p.id);
  saveRecipes();
  return { deleted: p.id };
});
api('GET', '/api/v1/scenarios/:date', (p) => ({ date: needDate(p), scenarios: scenariosOf(needDate(p)) }));
api('POST', '/api/v1/disruptions/:date', async (p, q, req) => {
  const d = needDate(p);
  const body = await readBody(req);
  if (!['breakdown', 'driver_absent', 'hot_order', 'failed_delivery'].includes(body.type)) { const e = new Error('type must be one of breakdown | driver_absent | hot_order | failed_delivery'); e.status = 400; throw e; }
  const preset = scenariosOf(d).find((s) => s.type === body.type) || {};
  const event = Object.assign({}, preset, body);
  if (event.time != null) event.time = Number(event.time);
  const out = E.disrupt(dayOf(d), event, { basePlan: planOf(d) });
  if (q.compact === '1') out.options.forEach((o) => delete o.plan);
  return Object.assign({ date: d }, out);
});

function openapi() {
  return {
    openapi: '3.0.3',
    info: { title: 'Trans Ontario Dispatch Copilot API', version: '1.0.0-demo', description: 'Plans, conflicts, explained decisions and disruption recovery options for Trans Ontario Express. Authenticate with the X-API-Key header (demo key: toe-demo-2026).' },
    servers: [{ url: '/' }],
    components: { securitySchemes: { ApiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } } },
    security: [{ ApiKey: [] }],
    paths: {
      '/api/v1/health': { get: { summary: 'Service health and available dates', security: [] } },
      '/api/v1/days': { get: { summary: 'Operating days in the dataset' } },
      '/api/v1/summary': { get: { summary: 'Copilot vs as-dispatched results across all days' } },
      '/api/v1/plan/{date}': { get: { summary: 'Recommended plan: routes, stop sequence, ETAs, load plans, partner tenders, KPIs, decision log' } },
      '/api/v1/plan/{date}/manual': { get: { summary: 'What dispatch actually did, re-costed with the same model' } },
      '/api/v1/plan/{date}/compare': { get: { summary: 'KPI comparison copilot vs manual vs GPS actuals' } },
      '/api/v1/plan/{date}/routes/{route}': { get: { summary: 'One route manifest (driver view) with the decisions behind it' } },
      '/api/v1/fleet/{date}': { get: { summary: 'Drivers and vehicles available that day, plan objectives and default settings' } },
      '/api/v1/plans/{date}': {
        get: { summary: 'All plans for the day (copilot, as dispatched, custom) with KPIs and fleet mix' },
        post: { summary: 'Build a custom plan', requestBody: { content: { 'application/json': { example: { name: 'Whole fleet, 12 h shifts', base: 'optimise', settings: { objective: 'balanced', maxDutyHours: 12, departTime: 420, serviceMin: 15, allowPartner: true, allowReloads: true, liveReplay: true, drivers: null } } } } } },
      },
      '/api/v1/plans/{date}/{id}': { get: { summary: 'One plan (copilot | manual | custom id)' }, delete: { summary: 'Delete a custom plan' } },
      '/api/v1/plans/{date}/{id}/moves': { post: { summary: 'Dispatcher edit: move a stop to another route or to a partner; returns the impact', requestBody: { content: { 'application/json': { example: { task: '0922-104', target: 'R02' } } } } } },
      '/api/v1/plans/{date}/{id}/undo': { post: { summary: 'Undo the last edit of a custom plan' } },
      '/api/v1/conflicts/{date}': { get: { summary: 'Detected problems with severity and suggested fix', parameters: [{ name: 'plan', in: 'query', schema: { type: 'string', description: 'copilot | manual | custom plan id' } }] } },
      '/api/v1/decisions/{date}': { get: { summary: 'Explained decision log', parameters: [{ name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'csv'] } }] } },
      '/api/v1/export/{date}': { get: { summary: 'Download the dispatch file (one row per stop, ready for Elite TMS / Samsara)', parameters: [{ name: 'format', in: 'query', schema: { type: 'string', enum: ['csv', 'json'] } }, { name: 'plan', in: 'query', schema: { type: 'string', description: 'copilot | manual | custom plan id' } }] } },
      '/api/v1/scenarios/{date}': { get: { summary: 'Ready-made disruption scenarios for the day' } },
      '/api/v1/disruptions/{date}': { post: { summary: 'Evaluate a disruption and get ranked recovery options', requestBody: { content: { 'application/json': { example: { type: 'breakdown', route: 'R01', time: 704 } } } } } },
      '/api/v1/assumptions': { get: { summary: 'Every modelling assumption behind the numbers', security: [] } },
    },
  };
}

// ------------------------------------------------------------------ server
const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const pathname = decodeURIComponent(u.pathname);
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (!pathname.startsWith('/api/')) return serveStatic(res, pathname);
  const t0 = Date.now();
  for (const r of routes) {
    const m = pathname.match(r.re);
    if (!m || r.method !== req.method) continue;
    if (!r.open && (req.headers['x-api-key'] || u.query.api_key) !== API_KEY) return err(res, 401, 'Missing or invalid API key. Send header X-API-Key.', { hint: 'Demo key: ' + API_KEY });
    try {
      const out = await r.handler(m.groups || {}, u.query, req, res);
      if (out !== undefined && !res.headersSent) send(res, 200, out, { 'X-Compute-Ms': String(Date.now() - t0) });
    } catch (e) {
      if (!res.headersSent) err(res, e.status || 500, e.message);
      if (!e.status) console.error(e);
    }
    console.log(`${req.method} ${req.url} ${Date.now() - t0}ms`);
    return;
  }
  err(res, 404, 'No such endpoint. See /api/v1/openapi.json');
});

server.listen(PORT, () => {
  console.log(`Dispatch Copilot running on http://localhost:${PORT}  (API key: ${API_KEY})`);
  // warm the cache in the background so the pitch numbers are instant
  // (one day per tick, so requests are served in between)
  const t = Date.now();
  const queue = [DEFAULT_DATE].concat(DATES.filter((d) => d !== DEFAULT_DATE));
  (function next() {
    const d = queue.shift();
    if (!d) { summaryAll(); console.log(`Planned ${DATES.length} days in ${Date.now() - t} ms`); return; }
    compareOf(d); scenariosOf(d);
    setTimeout(next, 5);
  })();
});
