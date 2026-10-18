"""
Builds data/dataset.json from the Trans Ontario routing report export.

Usage:
    python scripts/extract_data.py <routing-report.xlsx> [out.json]

The routing report already contains every table the copilot needs (stops,
order_legs, driver_days); the simple driver-day summary workbook is a
presentation of the same driver_days rows, so it is used only as a cross-check.

Everything here is a faithful copy of the export, with three exceptions that
are flagged on each record so the UI can show them as ESTIMATED:
  * skid spots / linear feet missing in Elite -> estimated from weight + piece type
  * weight missing or <= 1 lb                  -> estimated from pieces
  * driver licence class                       -> inferred from vehicles driven
"""
import json
import math
import sys
import collections
import datetime as dt

import openpyxl

DEPOT = {"name": "Trans Ontario Express - Scarborough terminal",
         "address": "2215 Markham Rd, Scarborough, ON M1B 2W3",
         "lat": 43.80800808529279, "lng": -79.24190011829823}


def mins(t):
    """Local datetime -> minutes after midnight of `day` (may exceed 1440)."""
    return None if t is None else t.hour * 60 + t.minute + round(t.second / 60)


def mins_on(t, day):
    if t is None:
        return None
    base = dt.datetime.fromisoformat(day)
    return round((t - base).total_seconds() / 60)


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def flag_list(text):
    return [s.strip() for s in (text or "").split(",") if s.strip()]


def load(path):
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    out = {}
    for name in ["routes", "stops", "order_legs", "driver_days"]:
        it = wb[name].iter_rows(values_only=True)
        hdr = next(it)
        out[name] = [dict(zip(hdr, r)) for r in it]
    return out


def vehicle_class(name):
    if not name:
        return None
    if name.startswith("Tractor"):
        return "TRACTOR_53"
    if name.startswith("Truck"):
        return "STRAIGHT_26"
    return "CARGO_VAN"  # plate-only unit (GFWE-PGJ-ZDE) behaves like a van / car


def main(src, dst):
    raw = load(src)
    stops, legs, ddays, routes = raw["stops"], raw["order_legs"], raw["driver_days"], raw["routes"]

    legs_by_stop = collections.defaultdict(list)
    for l in legs:
        legs_by_stop[(l["route_id"], l["stop_id"])].append(l)

    # ---- licence inference: anyone seen driving a tractor holds an AZ -------
    drove = collections.defaultdict(set)
    names = {}
    for d in ddays:
        if d["driver_name"]:
            names[d["driver_code"] or d["driver_id"]] = d["driver_name"]
        for v in (d["vehicles"] or "").split(", "):
            if v:
                drove[d["driver_code"] or d["driver_id"]].add(vehicle_class(v))

    days = sorted({s["service_date"] for s in stops})
    days = [d for d in days if sum(1 for s in stops if s["service_date"] == d) > 50]

    dataset = {
        "meta": {
            "source": src.split("/")[-1].split("\\")[-1],
            "company": "Trans Ontario Express (Elite company 20)",
            "period": [days[0], days[-1]],
            "generated": dt.datetime.now().isoformat(timespec="seconds"),
            "counts": {k: len(v) for k, v in raw.items()},
        },
        "depot": DEPOT,
        "days": {},
        "history": {},
    }

    # fleet-wide history used by the pitch page
    hist = collections.Counter()
    for r in routes:
        for k in ["n_appt_missed", "n_appt_risk", "n_updates", "n_stopcheck_reorders",
                  "n_x_cancels", "n_skipped", "plan_inversions"]:
            hist[k] += r[k] or 0
    hist["routes"] = len(routes)
    hist["customer_stops"] = sum(1 for s in stops if s["stop_type"] == "customer")
    hist["order_legs"] = len(legs)
    hist["gps_km"] = round(sum(r["actual_dist_km"] or 0 for r in routes))
    dataset["history"] = dict(hist)

    for day in days:
        day_stops = [s for s in stops if s["service_date"] == day and s["stop_type"] == "customer"]
        tasks = []
        ordno_actions = collections.defaultdict(dict)
        late_dispatch = 0
        for s in day_stops:
            sl = legs_by_stop[(s["route_id"], s["stop_id"])]
            est = []
            # --- freight per direction, from the leg rows ------------------
            pick_w = drop_w = 0.0
            pick_sp = drop_sp = 0.0
            pick_ft = drop_ft = 0.0
            for l in sl:
                w = num(l["tms_WGT"])
                if w is not None and l["tms_WGTCODE"] == "K":
                    w *= 2.20462
                if w is None:
                    w = num(l["weight"]) or 0
                sp = num(l["tms_SPOTS"]) or 0
                ft = num(l["tms_FEET"]) or 0
                if l["action"] == "P":
                    pick_w += w; pick_sp += sp; pick_ft += ft
                else:
                    drop_w += w; drop_sp += sp; drop_ft += ft
            if not sl:  # stop without leg detail: fall back to stop totals
                w = num(s["weight_lb"]) or 0
                if s["kind"] == "PICKUP":
                    pick_w = w
                else:
                    drop_w = w
            pieces = int(num(s["pieces"]) or 0)
            ptype = (s["piece_types"] or "").split(",")[0].strip() or None
            weight = pick_w + drop_w
            if weight <= 1:
                weight_est = max(pieces, 1) * 150
                est.append("weight")
                if s["kind"] == "PICKUP":
                    pick_w = weight_est
                else:
                    drop_w = weight_est
                weight = weight_est
            spots = pick_sp + drop_sp
            if spots <= 0:
                # 1 floor spot carries ~1,500 lb of skidded freight; loose pieces share spots
                if ptype in ("SKD", "PLT", "TRL", "Skid", "CRT", "BIN"):
                    spots = max(1, math.ceil(weight / 1500)) if weight > 150 else 0.5
                else:
                    spots = 0.25 if weight < 300 else max(0.5, round(weight / 2000, 1))
                spots = min(spots, 26)
                est.append("skid_spots")
                if s["kind"] == "PICKUP":
                    pick_sp = spots
                else:
                    drop_sp = spots
            feet = pick_ft + drop_ft
            if feet <= 0:
                est.append("linear_feet")

            handling = flag_list(s["special_handling"])
            equipment = flag_list(s["equipment_requested"])
            services = flag_list(s["services"])
            prov = None
            city = None
            dispatch_m = None
            appt_flag = False
            orders = []
            for l in sl:
                orders.append(l["ordno"] + l["action"])
                ordno_actions[l["ordno"]][l["action"]] = len(tasks)
                if l["action"] == "D":
                    prov = prov or l["tms_RC_PROV"]; city = city or l["tms_RC_CITY"]
                else:
                    prov = prov or l["tms_SH_PROV"]; city = city or l["tms_SH_CITY"]
                if l["tms_APPOINT"] == 1:
                    appt_flag = True
                dm = mins_on(l["dispatch_ts_local"], day)
                if dm is not None:
                    dispatch_m = dm if dispatch_m is None else min(dispatch_m, dm)
            if dispatch_m is not None and dispatch_m > 7 * 60:
                late_dispatch += 1
            appt = mins_on(s["appt_local"], day)
            if appt_flag and appt is None:
                est.append("appointment_time")

            veh = (s["vehicles"] or "").split(", ")[0] or None
            tasks.append({
                "id": f"{day[5:].replace('-', '')}-{len(tasks) + 1:03d}",
                "orders": orders or (s["orders"] or "").split(","),
                "kind": {"PICKUP": "P", "DROP-OFF": "D", "MULTI": "M"}.get(s["kind"], "D"),
                "customer": s["consignee"],
                "address": " ".join((s["address"] or "").split()),
                "city": (city or "").title() or None,
                "prov": prov or "ON",
                "lat": round(s["lat"], 6), "lng": round(s["lng"], 6),
                "pieces": pieces, "pieceType": ptype,
                "weight": round(weight), "pickW": round(pick_w), "dropW": round(drop_w),
                "spots": round(spots, 2), "pickSp": round(pick_sp, 2), "dropSp": round(drop_sp, 2),
                "feet": round(feet, 1),
                "dimWeight": num(s["dim_weight"]),
                "service": services, "equipment": equipment, "handling": handling,
                "appt": appt, "apptRequired": appt_flag,
                "dispatchedAt": dispatch_m,
                "estimated": est,
                "hist": {
                    "driver": s["driver_code"] or s["driver_id"],
                    "route": s["route_name"],
                    "vehicle": veh,
                    "trailer": s["trailers"],
                    "arr": mins_on(s["actual_arr_local"], day),
                    "dep": mins_on(s["actual_dep_local"], day),
                    "seq": s["actual_seq"],
                    "apptDelta": s["appt_delta_min"],
                    "skipped": s["state"] == "skipped",
                    "dwell": s["dwell_min"],
                },
            })

        # same-day pickup -> delivery pairs (pickup must precede its drop)
        pairs = []
        for ordno, acts in ordno_actions.items():
            if "P" in acts and "D" in acts and acts["P"] != acts["D"]:
                pairs.append([tasks[acts["P"]]["id"], tasks[acts["D"]]["id"], ordno])

        drivers = []
        for d in ddays:
            if d["day"] != day or not d["n_stops"]:
                continue
            code = d["driver_code"] or d["driver_id"]
            veh = (d["vehicles"] or "").split(", ")[0] or None
            classes = drove[code]
            drivers.append({
                "code": code,
                "name": d["driver_name"],
                "vehicle": veh,
                "vehicleClass": vehicle_class(veh) or "STRAIGHT_26",
                "trailer": d["trailers"],
                "licence": "AZ" if "TRACTOR_53" in classes else "DZ",
                "licenceInferred": True,
                "actual": {
                    "routes": d["n_routes"], "stops": d["n_stops"], "orders": d["n_orders"],
                    "km": d["actual_dist_km"], "spanMin": d["span_min"],
                    "driveMin": d["hos_drive_min"], "onDutyMin": d["hos_on_duty_min"],
                    "first": mins_on(d["first_arr_local"], day), "last": mins_on(d["last_dep_local"], day),
                    "weight": d["weight_lb"], "tollTrips": d["toll_trips"],
                },
            })
        working = {d["code"] for d in drivers}
        spares = []
        for code, cls in drove.items():
            if code not in working and code and cls and names.get(code):
                spares.append({"code": code, "name": names.get(code),
                               "licence": "AZ" if "TRACTOR_53" in cls else "DZ"})
        used = {d["vehicle"] for d in drivers}
        all_veh = sorted({v for dd in ddays for v in (dd["vehicles"] or "").split(", ") if v})
        spare_veh = sorted((v for v in all_veh if v not in used), key=lambda v: (not v.startswith("Truck"), v))

        day_routes = [r for r in routes if r["service_date"] == day]
        dataset["days"][day] = {
            "date": day,
            "weekday": dt.date.fromisoformat(day).strftime("%A"),
            "tasks": tasks,
            "pairs": pairs,
            "drivers": sorted(drivers, key=lambda d: d["code"]),
            "spareDrivers": sorted(spares, key=lambda d: d["code"])[:12],
            "spareVehicles": spare_veh[:10],
            "actualSummary": {
                "routes": len(day_routes),
                "drivers": len(drivers),
                "gpsKm": round(sum(r["actual_dist_km"] or 0 for r in day_routes), 1),
                "plannedKm": round(sum(r["planned_dist_km"] or 0 for r in day_routes), 1),
                "logbookKm": round(sum(d["hos_distance_km"] or 0 for d in ddays if d["day"] == day and d["n_stops"])),
                "apptMissed": sum(r["n_appt_missed"] or 0 for r in day_routes),
                "apptRisk": sum(r["n_appt_risk"] or 0 for r in day_routes),
                "replans": sum(r["n_updates"] or 0 for r in day_routes),
                "lateDispatched": late_dispatch,
            },
        }
        print(day, len(tasks), "tasks", len(pairs), "pairs", len(drivers), "drivers", late_dispatch, "late")

    # learned stop time per customer: median Samsara time on site on OTHER days (leave-one-day-out),
    # visits under 2 min are app taps, not measured visits; clamp to 5-90 min
    import statistics
    visits = collections.defaultdict(list)
    for d, v in dataset["days"].items():
        for t in v["tasks"]:
            w = (t.get("hist") or {}).get("dwell")
            if w is not None and w >= 2:
                visits[t["customer"]].append((d, w))
    for d, v in dataset["days"].items():
        for t in v["tasks"]:
            other = [w for dd, w in visits.get(t["customer"], []) if dd != d]
            if other:
                t["histSvc"] = round(min(90, max(5, statistics.median(other))), 1)
                t["histSvcN"] = len(other)

    # total distance the trucks' own ELD logbooks recorded (includes deadhead and terminal returns)
    dataset["history"]["logbook_km"] = round(sum(v["actualSummary"]["logbookKm"] for v in dataset["days"].values()))

    with open(dst, "w", encoding="utf-8") as f:
        json.dump(dataset, f, separators=(",", ":"), default=str)
    print("wrote", dst)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "data/dataset.json")
