#!/usr/bin/env python3
"""Diagnose why converged charge-start boundaries still permit 64 kWh / rolling 24h.

Runs variant A (fixed point on actual charge start) to convergence, then:
  1. rolling 24h charged-energy via np.convolve(0.9*chg, ones(48), 'valid')
  2. for the worst windows: print group edges, charge slots, per-group charged kWh
     for ~48 slots either side
  3. distribution of group lengths by month (do short groups cluster spring/autumn?)
"""
import sys
sys.path.insert(0, "/home/anthonynash/src/energy-battery-sim/test")
from adaptive_boundary import load, solve_groups, CAP, EFF, INV, SC_P_DAY
import argparse
import numpy as np

m, d = load()
imp = d["imp"].to_numpy(); exp = d["exp"].to_numpy(); load_ = d["kwh"].to_numpy()
wall = d["start_local"].dt.strftime("%Y-%m-%d %H:%M").tolist()
days = [w[:10] for w in wall]
T = len(imp)
cfg = m.Cfg(argparse.Namespace(capacity=CAP, round_trip=EFF, inverter_kw=INV,
                               total_import_limit_kw=None, max_charge_price=None,
                               export_limit_kw=None))

# variant A to convergence
midnight = [i for i in range(1, T) if days[i] != days[i - 1]]
bounds, prev = list(midnight), None
for it in range(1, 12):
    profit, chg, edges, first_chg = solve_groups(m, cfg, imp, exp, load_, bounds)
    new = sorted(first_chg.values())
    if new == prev:
        print(f"converged at iteration {it}")
        break
    prev, bounds = new, new

add = EFF * chg
roll = np.convolve(add, np.ones(48), mode="valid")
print(f"max rolling 24h: {roll.max():.2f} kWh, windows >32: {(roll > 32.0 + 1e-6).sum()}, "
      f">63.9: {(roll > 63.9).sum()}")

# per-group charged kWh
ed = np.array(edges)
grp_of = np.searchsorted(ed, np.arange(T), side="right") - 1
grp_charged = np.zeros(len(ed) - 1)
for i in range(T):
    grp_charged[grp_of[i]] += add[i]

# ---- worst window detail ----
def show_window(w0, tag):
    w1 = w0 + 48
    lo, hi = max(0, w0 - 48), min(T, w1 + 48)
    print(f"\n=== {tag}: window slots [{w0},{w1}) = {wall[w0]} .. {wall[w1-1]}, "
          f"charged {roll[w0]:.2f} kWh ===")
    gset = sorted(set(grp_of[lo:hi]))
    for g in gset:
        a, b = ed[g], ed[g + 1]
        cslots = [i for i in range(a, b) if add[i] > 1e-9]
        span = f"{wall[a]} -> {wall[min(b, T-1)]}" if b < T else f"{wall[a]} -> END"
        inwin = sum(add[i] for i in cslots if w0 <= i < w1)
        print(f"  group {g}: slots [{a},{b}) len {(b-a)*0.5:5.1f}h  {span}")
        print(f"    charged {grp_charged[g]:6.2f} kWh total, {inwin:6.2f} kWh inside window")
        if cslots:
            runs = []
            s = e = cslots[0]
            for i in cslots[1:]:
                if i == e + 1: e = i
                else: runs.append((s, e)); s = e = i
            runs.append((s, e))
            for s, e in runs:
                k = sum(add[i] for i in range(s, e + 1))
                print(f"    charge run {wall[s]} .. {wall[e]} ({k:.2f} kWh)")

# top offending windows, de-overlapped
order = np.argsort(roll)[::-1]
shown, used = 0, np.zeros(len(roll), bool)
for w in order:
    if roll[w] < 63.9 or used[max(0, w - 48):w + 48].any():
        if roll[w] < 63.9:
            break
        continue
    used[w] = True
    show_window(int(w), f"offender #{shown+1}")
    shown += 1
    if shown >= 4:
        break

# ---- cadence analysis ----
lens = np.diff(ed) * 0.5
print(f"\ngroup lengths: min {lens.min():.1f} max {lens.max():.1f} mean {lens.mean():.1f} h")
months = [wall[ed[g]][:7] for g in range(len(ed) - 1)]
print("\nshort groups (<18h) by month:")
from collections import Counter
short = Counter(mo for mo, L in zip(months, lens) if L < 18)
allm = Counter(months)
for mo in sorted(allm):
    n = short.get(mo, 0)
    print(f"  {mo}: {n:3d}/{allm[mo]:3d} short  {'#'*n}")

print("\nlong groups (>30h) by month:")
longc = Counter(mo for mo, L in zip(months, lens) if L > 30)
for mo in sorted(allm):
    n = longc.get(mo, 0)
    print(f"  {mo}: {n:3d}/{allm[mo]:3d} long   {'#'*n}")

# consecutive-boundary spacing where windows offend: are two full fills in one group,
# or across two groups with close charge starts?
print("\nboundary spacing distribution (h):")
sp = np.diff(np.array(sorted(bounds))) * 0.5
for lo_h, hi_h in [(0, 12), (12, 18), (18, 22), (22, 26), (26, 32), (32, 100)]:
    n = ((sp >= lo_h) & (sp < hi_h)).sum()
    print(f"  [{lo_h:3d},{hi_h:3d}): {n}")
