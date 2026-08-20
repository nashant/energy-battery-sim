#!/usr/bin/env python3
"""Quantify what 'accept and report' means under variant A: how often do two fills
really land inside 24h, how big is the stress, annual cycle counts. Also compare with
the coupled rolling-cap LP's own throughput profile for context."""
import sys
sys.path.insert(0, "/home/anthonynash/src/energy-battery-sim/test")
from adaptive_boundary import load, solve_groups, CAP, EFF, INV, SC_P_DAY
import argparse
from collections import Counter

import numpy as np

m, d = load()
imp = d["imp"].to_numpy(); exp_ = d["exp"].to_numpy(); load_ = d["kwh"].to_numpy()
wall = d["start_local"].dt.strftime("%Y-%m-%d %H:%M").tolist()
days = [w[:10] for w in wall]
T = len(imp)
cfg = m.Cfg(argparse.Namespace(capacity=CAP, round_trip=EFF, inverter_kw=INV,
                               total_import_limit_kw=None, max_charge_price=None,
                               export_limit_kw=None))
midnight = [i for i in range(1, T) if days[i] != days[i - 1]]

bounds, prev = list(midnight), None
for _ in range(12):
    _, _, _, first_chg = solve_groups(m, cfg, imp, exp_, load_, bounds)
    new = sorted(first_chg.values())
    if new == prev:
        break
    prev, bounds = new, new
profitA, chgA, edgesA, _ = solve_groups(m, cfg, imp, exp_, load_, bounds)
add = EFF * chgA

# distinct double-fill events: charge-start pairs < 24h apart
b = np.array(sorted(bounds))
sp = np.diff(b) * 0.5
close = np.where(sp < 24)[0]
print(f"variant A: {len(b)} charge starts; {len(close)} consecutive pairs <24h apart")
print(f"  spacing of those pairs: {sorted(np.round(sp[close],1))}")
mo = Counter(wall[b[i]][:7] for i in close)
print("  by month:", dict(sorted(mo.items())))

# how much total energy lands in those tight pairs
tot_fill = np.array([add[b0:b1].sum() for b0, b1 in zip(b[:-1], b[1:])])
print(f"  charged kWh in the tighter group of each pair: "
      f"min {tot_fill[close].min():.1f} max {tot_fill[close].max():.1f}")

# annual cycles
print(f"\nannual charged energy: {add.sum():,.0f} kWh = "
      f"{add.sum()/CAP:.0f} equivalent full cycles")

# distribution of rolling 24h throughput (how bad is the tail?)
roll = np.convolve(add, np.ones(48), mode="valid")
for th in (32.0, 40, 48, 56, 63.9):
    print(f"  rolling-24h > {th:5.1f} kWh: {(roll > th + 1e-9).sum():5d} window-slots "
          f"({(roll > th + 1e-9).sum()/48:.1f} day-equivalents)")

# context: the coupled rolling-cap LP charges how much per rolling 24h?
# (it is capped at 32 by construction; its equivalent cycles:)
print("\n(coupled LP reference: capped at 32 kWh/rolling-24h by construction)")

# calendar-day view: days whose calendar sum exceeds 32 under A
cal = {}
for t in range(T):
    cal[days[t]] = cal.get(days[t], 0.0) + add[t]
over = {k: v for k, v in cal.items() if v > CAP + 1e-6}
print(f"calendar days charging >32 kWh under A: {len(over)} "
      f"(max {max(over.values()) if over else 0:.1f} kWh)")
