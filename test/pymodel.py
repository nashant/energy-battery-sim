#!/usr/bin/env python3
"""Python reference for the app's dispatch model — the JS in js/optimiser.js and
js/data.js must match this exactly (asserted by test/validate.mjs, cycle.mjs, hold.mjs).

Three fixes over the raw CLI (agile-battery-sim.py), 2026-08-05:

1. NET SETTLEMENT BUCKETS: when an export price exceeds the import price, the inverter's
   output still offsets house load first — a single meter cannot settle both directions
   in one half-hour. The export bucket is therefore capped at the output room BEYOND the
   slot's load.
2. LOAD-PRIORITY REBALANCE: after allocation, any slot's discharge covers its load
   before exporting, so a slot can never show battery->grid alongside grid->house.
3. HOLD PASS: at each window boundary, energy the outgoing window would dump into its
   cheapest discharge slots is carried forward instead whenever the next window values
   it higher — serving load that falls before its discharge phase (bridging), or
   displacing its most expensive refill kWh. Windows still contain one fill; soc is no
   longer forced to zero at the boundary when that would waste money.
"""
import importlib.util

CLI = "/home/anthonynash/Downloads/agile-battery-sim.py"
EPS = 1e-9
MARGIN = 1e-6      # a candidate must beat the unwound value by this (p/kWh) to pair


def load_model():
    spec = importlib.util.spec_from_file_location("sim_cli", CLI)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    patch(m)
    return m


def patch(m):
    """Swap the CLI's discharge_buckets for the net-settlement version (fix 1)."""
    def discharge_buckets(imp, exp, load, s, allow_export, cfg):
        raw = []
        for t in range(s, len(imp)):
            lq = min(load[t], cfg.slot_out)
            raw.append((imp[t], lq, t, "load"))
            if allow_export:
                room = cfg.slot_out - lq if exp[t] > imp[t] else cfg.slot_out
                raw.append((exp[t], min(room, cfg.export_slot), t, "export"))
        raw.sort(key=lambda b: -b[0])
        rem, out = {}, []
        for val, qty, t, kind in raw:
            cap = rem.get(t, cfg.slot_out)
            q = min(qty, cap)
            if q <= 1e-12:
                continue
            rem[t] = cap - q
            out.append((val, q, t, kind))
        return out

    m.discharge_buckets = discharge_buckets


def rebalance(alloc, load):
    """Load-priority within each slot: discharge covers the slot's own load first."""
    for n, dd in alloc.items():
        tot = dd["load"] + dd["export"]
        l = min(load[n], tot)
        dd["load"], dd["export"] = l, tot - l


def solve_window(m, imp, exp, load, cfg, mode, allow_export):
    r = m.solve_day(imp, exp, load, cfg, mode, allow_export)
    # bind these once — `r.get(k) or {}` would hand mutations an orphan dict when the
    # attached dict is empty (empty dict is falsy), silently losing held energy
    r.setdefault("charge", {})
    r.setdefault("discharge", {})
    rebalance(r["discharge"], load)
    return r


def hold_pass(sols, imp, exp, load, cfg):
    """sols: ordered [{a, b, r}] with r['charge'] (local n -> imported kWh) and
    r['discharge'] (local n -> {'load','export'}). Mutates allocations; returns the
    inbound held kWh per group (index-aligned, [0] always 0)."""
    held = [0.0] * len(sols)
    for g in range(len(sols) - 1):
        w, w1 = sols[g], sols[g + 1]
        dis = w["r"]["discharge"]
        chg_w = w["r"]["charge"]
        last_chg = max(chg_w) if chg_w else -1
        unw = []                              # holdable tranches of w, cheapest first
        for n, dd in dis.items():
            if n <= last_chg:
                continue    # only tail discharge: unwinding pre-fill bridging would
            t = w["a"] + n  # leave inbound energy in the pack when the fill lands
            if dd["export"] > EPS:
                unw.append([exp[t], n, dd["export"], "export"])
            if dd["load"] > EPS:
                unw.append([imp[t], n, dd["load"], "load"])
        if not unw:
            continue
        unw.sort(key=lambda x: x[0])

        a1 = w1["a"]
        chg1 = w1["r"]["charge"]
        dis1 = w1["r"]["discharge"]
        s1 = min(dis1) if dis1 else (w1["b"] - a1)
        cand = []                             # what w1 would pay per delivered kWh
        for n in range(0, s1):
            t = a1 + n
            if chg1.get(n, 0.0) <= EPS and load[t] > EPS:
                cand.append([imp[t], n, min(load[t], cfg.slot_out), "load"])
        for n, c in chg1.items():
            cand.append([imp[a1 + n] / cfg.eff, n, c * cfg.eff, "fill"])
        cand.sort(key=lambda x: -x[0])

        plan, K, ui = [], 0.0, 0
        for v, n, q, kind in cand:
            while q > EPS and ui < len(unw):
                u = unw[ui]
                if u[0] >= v - MARGIN:
                    q = -1.0
                    break
                take = min(q, u[2])
                plan.append([take, u, n, kind, v])
                u[2] -= take
                q -= take
                K += take
                if u[2] <= EPS:
                    ui += 1
            if q < 0 or ui >= len(unw):
                break
        if K <= EPS:
            continue

        # feasibility: simulate w1 with inbound K; drop bridging items if soc would
        # exceed capacity (all-at-once fill patterns), cheapest-value first
        while True:
            add_l = {}
            cut_f = {}
            for take, u, n, kind, v in plan:
                if kind == "load":
                    add_l[n] = add_l.get(n, 0.0) + take
                else:
                    cut_f[n] = cut_f.get(n, 0.0) + take
            k_in = sum(x[0] for x in plan)
            soc, ok = k_in, True
            for n in range(0, w1["b"] - a1):
                soc += (chg1.get(n, 0.0) - cut_f.get(n, 0.0) / cfg.eff) * cfg.eff
                dd = dis1.get(n)
                if dd:
                    soc -= dd["load"] + dd["export"]
                soc -= add_l.get(n, 0.0)
                if soc > cfg.cap + 1e-6:
                    ok = False
                    break
            if ok:
                break
            drops = [p for p in plan if p[3] == "load"]
            if not drops:
                plan = []
                break
            plan.remove(min(drops, key=lambda p: p[4]))
        if not plan:
            continue

        K = 0.0
        for take, u, n, kind, v in plan:
            val, un, _, ukind = u
            dd = dis[un]
            dd[ukind] -= take                      # unwind w's cheap discharge
            if dd["load"] <= EPS and dd["export"] <= EPS:
                pass
            if kind == "load":                     # bridge w1's pre-discharge load
                dd1 = dis1.setdefault(n, {"load": 0.0, "export": 0.0})
                dd1["load"] += take
            else:                                  # displace w1's dearest refill kWh
                chg1[n] -= take / cfg.eff
                if chg1[n] <= EPS:
                    del chg1[n]
            K += take
        held[g + 1] = K
    return held


def book(sols, imp, exp, load, cfg):
    """Continuous-soc booking over the whole horizon. Returns totals in pence."""
    soc, energy_p, base_p, viol, out_kwh = 0.0, 0.0, 0.0, 0, 0.0
    for s in sols:
        a = s["a"]
        chg = s["r"]["charge"]
        dis = s["r"]["discharge"]
        for n in range(s["b"] - a):
            t = a + n
            c = chg.get(n, 0.0)
            dd = dis.get(n) or {"load": 0.0, "export": 0.0}
            soc += c * cfg.eff - dd["load"] - dd["export"]
            if soc < -1e-6 or soc > cfg.cap + 1e-6:
                viol += 1
            g_imp = load[t] + c - dd["load"]
            energy_p += g_imp * imp[t] - dd["export"] * exp[t]
            base_p += load[t] * imp[t]
            out_kwh += dd["load"] + dd["export"]
    return dict(energy_p=energy_p, base_p=base_p, violations=viol, out_kwh=out_kwh,
                end_soc=soc)
