#!/usr/bin/env python3
"""Generate hold_fixture.json: Python reference results for the hold pass (pymodel.py).
Uses the same input arrays as cycle_fixture.json (regenerate that first). test/hold.mjs
asserts the JS holdPass reproduces the identical held-energy sequence and totals."""
import json
import argparse

import numpy as np

from pymodel import load_model, solve_window, hold_pass, book
from adaptive_boundary import solve_groups, USAGE, PRICES, CAP, EFF

m = load_model()
d = m.load(USAGE, PRICES)
imp = d["imp"].tolist(); exp = d["exp"].tolist(); load_ = d["kwh"].tolist()
days = d["start_local"].dt.strftime("%Y-%m-%d").tolist()
T = len(imp)
imp_a, exp_a, load_a = d["imp"].to_numpy(), d["exp"].to_numpy(), d["kwh"].to_numpy()
midnight = [i for i in range(1, T) if days[i] != days[i - 1]]
mid_edges = [0] + midnight + [T]

CONFIGS = [
    {"name": "cycle 10kW export", "boundary": "cycle", "inverterKw": 10.0, "allowExport": True},
    {"name": "cycle 10kW contiguous (default)", "boundary": "cycle", "inverterKw": 10.0,
     "allowExport": True, "mode": "contiguous"},
    {"name": "midnight 10kW export", "boundary": "midnight", "inverterKw": 10.0, "allowExport": True},
    {"name": "midnight 6kW no-export", "boundary": "midnight", "inverterKw": 6.0, "allowExport": False},
]

out = {"configs": []}
for c in CONFIGS:
    cfg = m.Cfg(argparse.Namespace(capacity=CAP, round_trip=EFF, inverter_kw=c["inverterKw"],
                                   total_import_limit_kw=None, max_charge_price=None,
                                   export_limit_kw=None))
    mode = c.get("mode", "scattered")
    if c["boundary"] == "cycle":
        bounds, prev = list(midnight), None
        for _ in range(12):
            _, _, _, fc = solve_groups(m, cfg, imp_a, exp_a, load_a, bounds,
                                       mode=mode, allow_export=c["allowExport"])
            new = sorted(fc.values())
            if new == prev:
                break
            prev, bounds = new, new
        edges = sorted(set([0] + [b for b in bounds if 0 < b < T] + [T]))
    else:
        edges = mid_edges
    sols = []
    for g in range(len(edges) - 1):
        a, b = edges[g], edges[g + 1]
        r = solve_window(m, imp[a:b], exp[a:b], load_[a:b], cfg, mode,
                         c["allowExport"])
        sols.append({"a": a, "b": b, "r": r})
    held = hold_pass(sols, imp, exp, load_, cfg)
    bk = book(sols, imp, exp, load_, cfg)
    out["configs"].append({
        "name": c["name"], "boundary": c["boundary"], "allowExport": c["allowExport"],
        "mode": mode,
        "params": {"capacity": CAP, "roundTrip": EFF, "inverterKw": c["inverterKw"],
                   "exportLimitKw": None, "totalImportLimitKw": None,
                   "maxChargePrice": None},
        "edges": [int(e) for e in edges],
        "held": [[g, h] for g, h in enumerate(held) if h > 1e-9],
        "energy_p": bk["energy_p"], "out_kwh": bk["out_kwh"],
        "violations": bk["violations"], "end_soc": bk["end_soc"],
    })
    print(f"{c['name']:<26} energy £{bk['energy_p']/100:9.2f}  "
          f"held across {sum(1 for h in held if h > 1e-9)} boundaries "
          f"({sum(held):.1f} kWh)  cycled {bk['out_kwh']:,.0f} kWh  "
          f"violations {bk['violations']}")

with open("/home/anthonynash/src/energy-battery-sim/test/hold_fixture.json", "w") as f:
    json.dump(out, f)
print("wrote hold_fixture.json")
