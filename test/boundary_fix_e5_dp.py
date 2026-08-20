#!/usr/bin/env python3
"""E5: boundary-placement DP.

Root cause of the 64 kWh windows is trough ALTERNATION: consecutive charge starts land
12.5-13.5h apart when the solver switches between the (nearly equally deep) midday and
overnight troughs. E3b showed that fixing it inside frozen uneven groups costs £36. This
instead chooses the boundaries themselves: from a candidate set of plausible charge
starts, pick a chain with spacing in [24h, 60h] maximising total per-group solve_day
profit. Fully separable, one fill per group, spacing enforced by construction.

DP over candidates: dp[i] = best profit of a chain ending with a boundary at c_i.
"""
import sys
sys.path.insert(0, "/home/anthonynash/src/energy-battery-sim/test")
from adaptive_boundary import load, solve_groups, CAP, EFF, INV, SC_P_DAY
import argparse
import time

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

MIN_GAP, MAX_GAP = 48, 120   # 24h .. 60h between boundaries


def stats(label, profit, chg):
    add = EFF * chg
    roll = np.convolve(add, np.ones(48), mode="valid")
    tot = base - profit / 100 + sc
    print(f"{label:<52} £{tot:8,.2f}  max roll {roll.max():5.2f} kWh  "
          f"windows>32 {(roll > 32 + 1e-6).sum()}")
    return tot


# ---------- candidate charge starts ----------
# 1) charge starts under the midnight cut (first fixed-point iterate)
_, _, _, fc_mid = solve_groups(m, cfg, imp, exp_, load_, midnight)
cands = set(fc_mid.values())
# 2) converged variant A boundaries
bounds, prev = list(midnight), None
for _ in range(12):
    _, _, _, first_chg = solve_groups(m, cfg, imp, exp_, load_, bounds)
    new = sorted(first_chg.values())
    if new == prev:
        break
    prev, bounds = new, new
profitA, chgA, edgesA, _ = solve_groups(m, cfg, imp, exp_, load_, bounds)
stats("A) baseline", profitA, chgA)
cands |= set(bounds)
# 3) each calendar day's cheapest slot
for dd in range(len(midnight) + 1):
    a = 0 if dd == 0 else midnight[dd - 1]
    b = midnight[dd] if dd < len(midnight) else T
    cands.add(int(a + np.argmin(imp[a:b])))
cands = sorted(c for c in cands if 0 < c < T)
print(f"{len(cands)} candidate boundaries")

# ---------- DP ----------
memo = {}
calls = [0]


def gprofit(a, b):
    key = (a, b)
    if key not in memo:
        r = m.solve_day(imp[a:b].tolist(), exp_[a:b].tolist(), load_[a:b].tolist(),
                        cfg, "scattered", True)
        memo[key] = (r["profit"], r["charge"])
        calls[0] += 1
    return memo[key]


t0 = time.time()
C = [0] + cands + [T]           # index 0 = year start (not a spacing-checked boundary)
N = len(C)
NEG = -1e18
dp = [NEG] * N
back = [-1] * N
dp[0] = 0.0
for i in range(1, N):
    ci = C[i]
    for j in range(i - 1, -1, -1):
        cj = C[j]
        gap = ci - cj
        if gap > MAX_GAP and j > 0:
            break
        if j > 0 and gap < MIN_GAP:
            continue
        if j == 0 and gap > MAX_GAP:
            break
        if dp[j] == NEG:
            continue
        p, _ = gprofit(cj, ci)
        if dp[j] + p > dp[i]:
            dp[i], back[i] = dp[j] + p, j
# close the year: last group runs boundary -> T (spacing to T unconstrained above MIN? allow any tail)
bestp, besti = NEG, -1
for i in range(1, N - 1):
    if dp[i] == NEG or T - C[i] > MAX_GAP:
        continue
    p, _ = gprofit(C[i], T)
    if dp[i] + p > bestp:
        bestp, besti = dp[i] + p, i
print(f"DP done: {calls[0]} solve_day calls in {time.time()-t0:.0f}s")

# reconstruct
chain = []
i = besti
while i > 0:
    chain.append(C[i])
    i = back[i]
chain = sorted(chain)
gaps = np.diff([0] + chain + [T]) * 0.5
print(f"chain: {len(chain)} boundaries, group length {gaps.min():.1f}-{gaps.max():.1f}h "
      f"(mean {gaps.mean():.1f})")

profit5, chg5, edges5, _ = solve_groups(m, cfg, imp, exp_, load_, chain)
stats("E5) boundary-placement DP (>=24h spacing)", profit5, chg5)

# where does residual rolling excess (if any) come from?
add = EFF * chg5
roll = np.convolve(add, np.ones(48), mode="valid")
viol = np.where(roll > CAP + 1e-6)[0]
if len(viol):
    w = int(viol[np.argmax(roll[viol])])
    print(f"worst residual window at slot {w}: {roll[w]:.2f} kWh")

print("\nreference: shipped £703.22 | A £680.63 | E3b honest-capped £716.46 | "
      "rolling-cap LP £671.39")
