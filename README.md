# Dispatch Copilot: Trans Ontario Express

**Smarter Freight, Smarter Routes**: Catalyst Hackathon · Team #13

An AI dispatch copilot for George, Trans Ontario's dispatcher. It works alongside the two systems Trans Ontario already runs:

- **Elite TMS** is the transportation management system. Orders are booked here, and the dispatcher assigns every pickup and delivery leg to a driver.
- **Samsara** is the fleet telematics platform: GPS tracking, the driver app that shows each route, and the electronic logbook for hours of service.

The copilot does three things:

1. **Plan the day.** It assigns every leg to a compatible truck and driver, sequences the stops, builds a LIFO load plan, and decides when to tender to a partner carrier.
2. **Identify problems.** It catches overloads, wrong equipment, missed appointments, HOS breaches, dangerous-goods issues and missing data before trucks leave.
3. **Adapt.** For a breakdown, a sick call, a rush order or a failed delivery, it returns ranked, costed recovery options in milliseconds.
4. **Connect drivers and dispatch.** In the phone-friendly **Driver view**, a driver taps *Report a problem* (heavy traffic, road closed, hazardous conditions, truck problem). The copilot re-plans at once, the driver sees new ETAs, and an alert pops up for the dispatcher with the recommended fix.

Every recommendation comes with a reason, and every estimate is labelled.

## Run it

Requires Node 18+. There are no npm dependencies.

```bash
node server.js
```

Open http://localhost:8080. On first start the server plans all 10 days, which takes about 15 s in the background. The status dot re-checks the API every 15 seconds: green means connected, red means the server stopped answering (with a message and automatic reconnect), amber means no server was found and the planner runs in the browser.

## Demo script (5 minutes)

| # | Page | What to show |
|---|------|--------------|
| 1 | **Pitch** | The problem in Trans Ontario's own data, then 10-day results vs as-dispatched |
| 2 | **Plan the Day** (Tue 22 Sep) | Truck/km/on-time KPIs vs George's plan. Press **Replay day** to watch call-in pickups get inserted live at their real Elite dispatch times |
| 2b | **Build a plan** | Choose an objective (lowest cost, best service, use the whole fleet, fewest km), the drivers and trucks, and shift rules. Or copy a plan and use **Move to…** on any stop. Every plan appears in **Compare plans** |
| 3 | Click a route | Stop timeline with windows, the **LIFO deck plan** for the dock, and "why this route" decisions |
| 4 | **Problems** | As dispatched vs copilot: missed appointments, overloads, HOS breaches, data gaps, each with a suggested fix |
| 5 | **Adapt** | Truck breakdown mid-route: three costed options, then **Apply**. The plan updates and the decision downloads as JSON |
| 5b | **Driver view** (on a phone or a narrow window) | Pick R20 at 10:00, tap **Heavy traffic** (tick more than one problem if you like), **45 min**, **Send to dispatch**. New ETAs appear for the driver; on the dispatcher's screen an alert offers **Review options** |
| 6 | **API & Exports** | Live "Try" console, dispatch CSV, decision log CSV, OpenAPI spec |

## Results on the real export (20 Sep – 3 Oct 2026, 10 operating days)

Both plans are scored with the same distance, time and cost model.

| | As dispatched | Copilot |
|---|---|---|
| Truck floor space used | 60% | 75% |
| Stops per 53′ trailer / straight truck / van | 3.6 / 7.3 / 4.0 | 8.9 / 8.1 / 5.4 |
| Overloaded or wrong-vehicle trucks (10 days) | 88 | 0 |
| Trucks in service per day | 40–46 | about 30 (the rest on standby) |
| Distance | baseline | about 15% less (13,600 km) |
| Stops on time | 93.8% | 99.3% |
| Operating cost | baseline | about 14% less ($32.6k over 10 days); lower on 9 of the 10 days |
| Driver hours | 3,837 h | 3,010 h (827 h freed) |
| Capacity, HOS and equipment violations | several per day | 0 |
| Critical problems found (10 days) | 183 | 4 |

The pitch page computes these numbers live from `/api/v1/summary`.

**Stop times are learned from history.** Each stop takes the median time Samsara GPS recorded at that customer on *other* days (5 to 90 min), so routes are sized for how long stops really take. About 60% of stops have a learned time; customers with no visit on another day use the 15 min + extras rule. Both plans use the same stop times.

**Where the cost saving comes from.** Most of it is driver hours: about 830 hours freed over 10 days because fewer trucks are needed. If those drivers stay on payroll, treat this as capacity for growth, call-ins and less overtime rather than cash; the "Use the whole fleet" plan keeps every truck working.

**Distance reality check.** Our model estimates George's plan at 89,438 km over the 10 days. The trucks' own Samsara logbooks recorded 99,003 km, so the model is about 10% *below* reality and the distance and cost savings are conservative. Route GPS (61,840 km) is lower still because it only counts driving inside Samsara routes. The Data & Assumptions page shows this check for each day.

**Why fewer trucks?** Each load is matched to the vehicle type that fits it:

- 53′ trailers run full, multi-stop loads instead of single drops.
- Straight trucks take the city multi-drop, tailgate and residential work.
- The van takes small rush parcels.

Nothing is overloaded or on the wrong equipment, so the same freight fits on fewer units, and roughly 13 trucks a day stay free for breakdowns and call-ins. If you'd rather keep every truck rolling, a custom plan with **Use the whole fleet** spreads the work across all units (for example, 38 trucks on 22 Sep at about +$375, with every appointment met).

## API

The base path is `/api/v1`. Send the header `X-API-Key: toe-demo-2026`; `?api_key=` also works for download links. Set the env vars `API_KEY` and `PORT` to change them.

| Method | Path | Returns |
|---|---|---|
| GET | `/health` | status, dataset, dates *(no key)* |
| GET | `/summary` | copilot vs manual across all days |
| GET | `/plan/{date}` | full plan: routes, ETAs, load plans, partner tenders, KPIs, decisions |
| GET | `/plan/{date}/manual` | as-dispatched baseline, re-costed |
| GET | `/plan/{date}/compare` | KPI comparison incl. GPS actuals |
| GET | `/plan/{date}/routes/{id}` | one route manifest + its decisions |
| GET | `/conflicts/{date}?plan=copilot\|manual\|{id}` | problems with severity and fix |
| GET | `/decisions/{date}?format=json\|csv` | explained decision log (download) |
| GET | `/export/{date}?format=csv\|json` | dispatch file, one row per stop (download) |
| GET | `/fleet/{date}` | drivers and units available, objectives, default settings |
| GET | `/plans/{date}` | every plan for the day (copilot, as dispatched, custom) with KPIs and fleet mix |
| POST | `/plans/{date}` | build a custom plan: `{name, base: optimise\|copilot\|manual, settings: {objective, drivers, maxDutyHours, departTime, serviceMin, allowPartner, allowReloads, liveReplay}}` |
| GET / DELETE | `/plans/{date}/{id}` | one plan / delete a custom plan |
| POST | `/plans/{date}/{id}/moves` | dispatcher edit `{task, target: routeId\|PARTNER}` → impact and broken rules |
| POST | `/plans/{date}/{id}/undo` | undo the last edit |
| GET | `/scenarios/{date}` | ready-made disruption scenarios |
| POST | `/disruptions/{date}` | `{type, route?, time?, pickup?, task?}` → ranked recovery options |
| POST | `/reports/{date}` | driver reports a problem `{route, kind: traffic\|road_closed\|hazard\|truck, delayMin, time}` → recovery options |
| GET | `/reports/{date}` | driver reports for the day (dispatcher alerts) |
| GET / DELETE | `/reports/{date}/{id}` | one report with its options / dismiss it |
| GET | `/assumptions` | every modelling assumption *(no key)* |
| GET | `/openapi.json` | OpenAPI 3 spec *(no key)* |

```bash
curl -X POST -H "X-API-Key: toe-demo-2026" -H "Content-Type: application/json" \
  -d '{"type":"breakdown","route":"R05","time":553}' \
  http://localhost:8080/api/v1/disruptions/2026-09-22
```

## How it works

- `scripts/extract_data.py` turns the routing-report workbook into `data/dataset.json`. It reads the stops, order legs (Elite ORDERTRAIL) and driver days (Samsara HOS and vehicle log).
- `engine/engine.js` is the planner. The same file runs in Node and in the browser, so the UI still works offline.
  - **Construction:** regret-2 insertion with pickup→delivery pairs, mid-day terminal reloads, vehicle capacity (lb and skid spots), equipment and licence compatibility, appointment windows, service promises, and HOS limits (13 h driving, 14 h on duty).
  - **Improvement:** relocate local search.
  - **Partner economics:** freight outside ON/QC, or freight whose in-house marginal cost is higher than the partner quote, is tendered to a partner.
  - **Live replay:** the morning plan holds terminal freight plus pickups booked by 07:00. Every later pickup is inserted at its real Elite dispatch time, with work already done frozen.
  - **Disruptions:** freeze at the event time, then evaluate the alternatives (rescue/redistribute, spare driver or truck, partner, retry or hand-off) against the same frozen baseline.
- **Custom plans** are saved as recipes (a starting point, settings and a list of dispatcher moves) in `data/custom-plans.json` and rebuilt deterministically. Export, decisions and conflicts all accept `?plan={id}`.
- `server.js` is a zero-dependency HTTP server for the API and the static front end.
- `public/` holds the dispatcher console: vanilla JS, Leaflet, and the brand colours and Montserrat from the guidelines.

To rebuild the dataset from a new export:

```bash
python scripts/extract_data.py ../routing-report-YYYY-MM-DD-YYYY-MM-DD.xlsx data/dataset.json
```

## Assumptions and simplifications

All of these are also listed on the **Data & Assumptions** page:

- Road distance is straight-line distance × 1.3. Speed is 32 km/h for the first 15 km of a leg and 68 km/h after that. Production would use Google Routes or Samsara distances.
- Vehicle class is inferred from the unit name: straight 26′ (10,000 lb / 12 spots), 53′ trailer (48,000 lb / 26 spots), van (2,500 lb / 2 spots).
- Driver licence is inferred: AZ if the driver was ever seen in a tractor, otherwise DZ.
- Skid spots are blank in Elite for about 65% of stops. They are estimated from weight and piece type and tagged **EST**.
- Copilot trucks leave at 07:00, or on an early-start shift from 03:30 when the first stop has an early appointment (drivers in the export left as early as 03:36).
- George's as-dispatched routes leave when each driver really left (first GPS arrival minus the modelled drive), including night starts, and pickups booked the day before are ready from midnight. On 10 days of GPS the rebuilt routes arrive within about 50 minutes of the real arrival on average.
- Every late or tight stop carries an explanation: the main cause (booked too late, other stops came first, truck left too late, road & weather event) and how the time from departure to arrival adds up.
- Simulated road & weather events (top-bar switch, off by default): a planned ramp closure, construction, a weather band, event traffic and one or two accidents per day. The copilot plans around the ones known in advance; accidents hit every plan. Headline results are computed with events off.
- A pickup booked less than 30 minutes before its appointment is flagged as impossible to meet (a rebooking warning), not as a planning miss. Deliveries are not exempt: their freight is already in the terminal, so a missed delivery appointment counts as a real miss.
- Terminal freight is loaded before departure. Pickups become known only at their Elite dispatch time.
- Costs are indicative: $34/h driver with an 8 h minimum, $/km by vehicle class, and formula-based partner quotes.
- Live traffic is not connected in the prototype: the driver reports the delay. In production, Google Routes or Samsara traffic data would raise the same alert automatically.
- A reported delay starts counting from the truck's next departure; a road closure adds a 12 km detour.
- Customer names are pseudonymised in the source export. Addresses, orders, drivers and times are real.
