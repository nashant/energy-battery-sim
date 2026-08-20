#!/usr/bin/env python3
"""Where does the optimiser export cheaper than it buys, and why?

Categories:
  A  same window: grid-drawn house load DURING the charge phase at a higher price than a
     later export. Cause: the one-cycle rule (all charging precedes all discharging), so
     the pack cannot serve load mid-charge-phase.
  B  same window: grid-drawn (uncovered) house load in the DISCHARGE phase at a higher
     price than an export. Should be ~zero by the greedy exchange argument, except where
     the per-slot inverter cap binds.
  C  cross-boundary: end-of-window dump exports at price p, then the next cycle refills
     at marginal delivered cost q/eff > p. Cause: energy balance + soc=0 at boundaries
     (the measured ~£40/yr carryover gap).

Region J, Agile+Outgoing, 32 kWh, 10 kW, cycle-boundary mode (charge-start windows).
"""
import sys
sys.path.insert(0, "/home/anthonynash/src/energy-battery-sim/test")
from adaptive_boundary import load, solve_groups, CAP, EFF, INV
import argparse

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
    _, _, _, fc = solve_groups(m, cfg, imp, exp_, load_, bounds)
    new = sorted(fc.values())
    if new == prev:
        break
    prev, bounds = new, new
edges = sorted(set([0] + [b for b in bounds if 0 < b < T] + [T]))

# per-slot schedule
chg = np.zeros(T); disL = np.zeros(T); disE = np.zeros(T)
wins = []
for g in range(len(edges) - 1):
    a, b = edges[g], edges[g + 1]
    if b - a < 2:
        continue
    r = m.solve_day(imp[a:b].tolist(), exp_[a:b].tolist(), load_[a:b].tolist(),
                    cfg, "scattered", True)
    for n, k in r["charge"].items():
        chg[a + n] = k
    for n, dd in r.get("discharge", {}).items():
        disL[a + n] = dd["load"]; disE[a + n] = dd["export"]
    wins.append((a, b))

uncov = load_ - disL                     # house load drawn from grid
EPS = 1e-9

# ---- categories A and B (within window) ----
lossA = lossB = 0.0; nA = nB = 0
perday_A = np.zeros(len(midnight) + 1)
for a, b in wins:
    ex = sorted([(exp_[t], t, disE[t]) for t in range(a, b) if disE[t] > EPS])
    if not ex:
        continue
    cslots = [t for t in range(a, b) if chg[t] > EPS]
    last_chg = max(cslots) if cslots else a - 1
    # dearest uncovered load first, cheapest export first
    for phase, tag in ((range(a, last_chg + 1), 'A'), (range(last_chg + 1, b), 'B')):
        drawn = sorted([(imp[t], t, uncov[t]) for t in phase if uncov[t] > EPS],
                       reverse=True)
        ei = 0; eq = ex[0][2] if ex else 0.0
        exl = [list(x) for x in ex]
        for q, t, kwh in drawn:
            k = kwh
            for e in exl:
                if e[2] <= EPS or e[0] >= q - EPS:
                    continue
                x = min(k, e[2])
                if tag == 'A':
                    lossA += (q - e[0]) * x / 100; nA += x
                    perday_A[np.searchsorted(np.array([0] + midnight), t, 'right') - 1] += (q - e[0]) * x / 100
                else:
                    lossB += (q - e[0]) * x / 100; nB += x
                e[2] -= x; k -= x
                if k <= EPS:
                    break

# ---- category C (cross-boundary sell-low, rebuy-high) ----
lossC = 0.0; nC = 0
perday_C = np.zeros(len(midnight) + 1)
detail_C = []
mid_arr = np.array([0] + midnight)
for i in range(len(wins) - 1):
    a, b = wins[i]; a2, b2 = wins[i + 1]
    ex = sorted([[exp_[t], t, disE[t]] for t in range(a, b) if disE[t] > EPS])
    rc = sorted([[imp[t] / EFF, t, chg[t] * EFF] for t in range(a2, b2) if chg[t] > EPS],
                reverse=True)   # marginal delivered cost of refill kWh, dearest first
    got = 0.0
    for q, tq, kq in rc:
        for e in ex:
            if e[2] <= EPS or e[0] >= q - EPS:
                continue
            x = min(kq, e[2])
            lossC += (q - e[0]) * x / 100; nC += x; got += (q - e[0]) * x / 100
            perday_C[np.searchsorted(mid_arr, e[1], 'right') - 1] += (q - e[0]) * x / 100
            e[2] -= x; kq -= x
            if kq <= EPS:
                break
    if got > 0.005:
        detail_C.append((got, a, b, a2, b2))

print(f"windows: {len(wins)}")
print(f"A  load drawn during charge phase dearer than a later export: "
      f"{nA:6.1f} kWh  est. £{lossA:6.2f}/yr")
print(f"B  uncovered load in discharge phase dearer than an export:   "
      f"{nB:6.1f} kWh  est. £{lossB:6.2f}/yr")
print(f"C  dump export cheaper than next cycle's refill (q/eff):      "
      f"{nC:6.1f} kWh  est. £{lossC:6.2f}/yr")

# ---- category D: simultaneous grid import AND battery export in one slot ----
# Physically a single meter nets to one direction; the model books gross both ways.
# Overstatement vs net settlement = (exp - imp) * min(export, grid_import) when exp > imp.
gridImp = load_ - disL + chg
both = [(t, gridImp[t], disE[t], imp[t], exp_[t]) for t in range(T)
        if disE[t] > EPS and gridImp[t] > EPS]
overst = sum((e - i) * min(gi, de) for t, gi, de, i, e in both if e > i) / 100
inverted = [x for x in both if x[4] > x[3]]
print(f"\nD  slots exporting AND importing simultaneously: {len(both)} "
      f"({len(inverted)} with exp>imp; phantom value vs net settlement £{overst:.2f}/yr)")
for t, gi, de, i, e in sorted(inverted, key=lambda x: -(x[4] - x[3]) * min(x[1], x[2]))[:6]:
    print(f"   {wall[t]}  imp {i:6.2f}p exp {e:6.2f}p  grid-in {gi:.2f} kWh, "
          f"batt->grid {de:.2f} kWh  (load {load_[t]:.2f}, chg {chg[t]:.2f})")
n_normal = len(both) - len(inverted)
if n_normal:
    print(f"   ({n_normal} further slots have exp<imp — uncovered load beside export; "
          f"netting would IMPROVE those, worth "
          f"£{sum((i - e) * min(gi, de) for t, gi, de, i, e in both if i >= e)/100:.2f}/yr)")

# ---- worst consecutive 5-day sample ----
tot_day = perday_A + perday_C
best5, s5 = 0.0, 0
for s in range(len(tot_day) - 5):
    v = tot_day[s:s + 5].sum()
    if v > best5:
        best5, s5 = v, s
d0 = days[mid_arr[s5]]
d4 = days[min(mid_arr[s5 + 4], T - 1)]
print(f"\nworst 5-day sample: {d0} .. {d4}  (est. £{best5:.2f} recoverable)")

lo = mid_arr[s5]; hi = mid_arr[s5 + 5] if s5 + 5 < len(mid_arr) else T
print(f"\nslot-level story ({d0}..{d4}; only slots with battery/grid activity):")
print(f"{'slot':<17}{'imp':>7}{'exp':>7}{'load':>7}{'chg->batt':>10}{'batt->load':>11}"
      f"{'batt->exp':>10}{'grid':>7}")
bset = set(edges)
for t in range(lo, hi):
    grid = load_[t] - disL[t] + chg[t]
    act = chg[t] > EPS or disE[t] > EPS or disL[t] > EPS
    if not act and uncov[t] < 0.3:
        continue
    mark = ' <== new cycle window' if t in bset else ''
    print(f"{wall[t]:<17}{imp[t]:7.2f}{exp_[t]:7.2f}{load_[t]:7.2f}"
          f"{chg[t]:10.2f}{disL[t]:11.2f}{disE[t]:10.2f}{grid:7.2f}{mark}")

print("\ntop cross-boundary events in/near the sample:")
for got, a, b, a2, b2 in sorted(detail_C, reverse=True)[:8]:
    exs = [(exp_[t], disE[t]) for t in range(a, b) if disE[t] > EPS]
    rcs = [(imp[t], chg[t]) for t in range(a2, b2) if chg[t] > EPS]
    print(f"  £{got:5.2f}  window {wall[a]}→{wall[b-1]} exported "
          f"{sum(k for _, k in exs):5.1f} kWh @ {min(p for p, _ in exs):5.2f}–"
          f"{max(p for p, _ in exs):5.2f}p; refill {wall[a2]} @ "
          f"{min(p for p, _ in rcs):5.2f}–{max(p for p, _ in rcs):5.2f}p import "
          f"(={min(p for p, _ in rcs)/EFF:5.2f}–{max(p for p, _ in rcs)/EFF:5.2f}p/kWh delivered)")
