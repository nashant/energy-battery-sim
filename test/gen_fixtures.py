#!/usr/bin/env python3
"""Regenerate the per-day profits in fixtures.json against the current Python reference
model (test/pymodel.py). Reuses the stored per-day price/load arrays, so only `profit`,
`kwh_out` and `total_profit` change."""
import argparse
import json

from pymodel import load_model

PATH = "/home/anthonynash/src/energy-battery-sim/test/fixtures.json"

m = load_model()
fx = json.load(open(PATH))
for f in fx:
    p = f["params"]
    cfg = m.Cfg(argparse.Namespace(
        capacity=p["capacity"], round_trip=p["roundTrip"], inverter_kw=p["inverterKw"],
        total_import_limit_kw=p["totalImportLimitKw"], max_charge_price=p["maxChargePrice"],
        export_limit_kw=p["exportLimitKw"]))
    total, changed = 0.0, 0
    for d in f["days"]:
        r = m.solve_day(d["imp"], d["exp"], d["load"], cfg, f["mode"], f["allowExport"])
        if abs(r["profit"] - d["profit"]) > 1e-9:
            changed += 1
        d["profit"] = r["profit"]
        d["kwh_out"] = r["kwh_out"]
        total += r["profit"]
    old = f["total_profit"]
    f["total_profit"] = total
    print(f"{f['config']['name']:<32} £{old/100:9.2f} -> £{total/100:9.2f} "
          f"({changed} days changed)")

json.dump(fx, open(PATH, "w"))
print("rewrote fixtures.json")
