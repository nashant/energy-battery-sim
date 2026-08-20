#!/usr/bin/env python3
"""Honest coupled benchmark under Anthony's cycle semantics: one fill per cycle-window
(charge-start to charge-start), windows taken from converged variant A.

LP: carryover soc (continuous all year), charge cap 32 kWh per A-group instead of per
calendar day. Also reports LP soc at A's boundaries -- if ~0, A's soc=0 assumption is
near-optimal and the residual gap is pure boundary-coupling.
"""
import sys
sys.path.insert(0, "/home/anthonynash/src/energy-battery-sim/test")
from adaptive_boundary import load, solve_groups, CAP, EFF, INV, SC_P_DAY
from carryover_lp import solve_lp
import argparse

import numpy as np

m, d = load()
imp = d["imp"].to_numpy(); exp_ = d["exp"].to_numpy(); load_ = d["kwh"].to_numpy()
days = [w[:10] for w in d["start_local"].dt.strftime("%Y-%m-%d %H:%M").tolist()]
T = len(imp)
sc = SC_P_DAY * T / 48 / 100
base = float((load_ * imp).sum()) / 100
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
totA = base - profitA / 100 + sc
print(f"A (separable, soc=0 at each charge start):        £{totA:8,.2f}")

# group label per slot from A's windows
ed = np.array(edgesA)
glab = (np.searchsorted(ed, np.arange(T), side="right") - 1).tolist()

r = solve_lp(load_, imp, exp_, glab, carryover=True, cycle_cap=True)
print(f"LP carryover, 32 kWh cap per A cycle-window:      £{r['energy'] + sc:8,.2f}  "
      f"charged {r['charged']:,.0f} kWh")

# soc at A's boundaries under the LP
soc = r["soc"]
bsoc = np.array([soc[b - 1] for b in bounds])
print(f"LP soc at A's {len(bounds)} boundaries: mean {bsoc.mean():.2f} kWh, "
      f"median {np.median(bsoc):.2f}, p90 {np.percentile(bsoc, 90):.2f}, "
      f"max {bsoc.max():.2f}; boundaries with soc<0.5 kWh: {(bsoc < 0.5).sum()}")

# references
print(f"\nshipped £703.22 | A £{totA:,.2f} | calendar-cap carryover LP £647.13 | "
      "rolling-cap LP £671.39")
