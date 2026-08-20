#!/usr/bin/env python3
"""Generate cycle_fixture.json: the Python reference for the 'discharge by next charge
cycle' boundary mode (fixed point on actual charge starts, test/adaptive_boundary.py).

Holds the exact input arrays plus Python's converged group edges and per-group profits,
so test/cycle.mjs can assert the JS port converges to the identical structure.
"""
import argparse
import json

from adaptive_boundary import load, solve_groups, CAP, EFF, SC_P_DAY
from pymodel import patch

CONFIGS = [10.0, 6.0]

m, d = load()
patch(m)   # net-settlement buckets — keep in lockstep with js/optimiser.js
imp = d["imp"].tolist()
exp = d["exp"].tolist()
load_ = d["kwh"].tolist()
days = [w[:10] for w in d["start_local"].dt.strftime("%Y-%m-%d %H:%M").tolist()]
T = len(imp)
midnight = [i for i in range(1, T) if days[i] != days[i - 1]]

out = {"imp": imp, "exp": exp, "load": load_, "days": days, "configs": []}
for inv in CONFIGS:
    cfg = m.Cfg(argparse.Namespace(capacity=CAP, round_trip=EFF, inverter_kw=inv,
                                   total_import_limit_kw=None, max_charge_price=None,
                                   export_limit_kw=None))
    bounds, prev, iters = list(midnight), None, 0
    for it in range(1, 13):
        _, _, _, first_chg = solve_groups(m, cfg, imp_a := d["imp"].to_numpy(),
                                          d["exp"].to_numpy(), d["kwh"].to_numpy(), bounds)
        new = sorted(first_chg.values())
        iters = it
        if new == prev:
            break
        prev, bounds = new, new
    profit, chg, edges, _ = solve_groups(m, cfg, d["imp"].to_numpy(), d["exp"].to_numpy(),
                                         d["kwh"].to_numpy(), bounds)
    base = float((d["kwh"].to_numpy() * d["imp"].to_numpy()).sum()) / 100
    sc = SC_P_DAY * T / 48 / 100
    out["configs"].append({
        "name": f"cycle boundary, {inv:g} kW",
        "params": {"capacity": CAP, "roundTrip": EFF, "inverterKw": inv,
                   "exportLimitKw": None, "totalImportLimitKw": None,
                   "maxChargePrice": None},
        "mode": "scattered", "allowExport": True,
        "iterations": iters,
        "edges": [int(e) for e in edges],
        "profit": profit,
        "totalWithFlatSc": base - profit / 100 + sc,
    })
    print(f"{inv:g} kW: {len(edges)-1} groups, converged it {iters}, "
          f"profit {profit:.4f}p, total £{out['configs'][-1]['totalWithFlatSc']:.2f}")

with open("/home/anthonynash/src/energy-battery-sim/test/cycle_fixture.json", "w") as f:
    json.dump(out, f)
print("wrote cycle_fixture.json")
