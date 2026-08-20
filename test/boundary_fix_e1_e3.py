#!/usr/bin/env python3
"""Test fixes for the two-fills-in-24h problem in the adaptive charge-start boundary.

Root cause (measured): the optimiser alternates between the midday and overnight price
troughs on consecutive days; each midday->overnight switch puts two full 32 kWh charge
starts ~12.5-13.5h apart. One fill per group holds; spacing between groups doesn't.

E1  bounded-offset fixed point: boundary for day d clamped to midnight_d + [-3h, +18h]
E2  fixed point seeded from each day's cheapest slot instead of midnight
E3  post-hoc feasibility filter: converged variant A, then re-solve only the violating
    chains of groups with a mini-LP that carries a rolling 24h charge cap
"""
import sys
sys.path.insert(0, "/home/anthonynash/src/energy-battery-sim/test")
from adaptive_boundary import load, solve_groups, CAP, EFF, INV, SC_P_DAY
import argparse
from collections import defaultdict

import numpy as np
from scipy.optimize import linprog
from scipy.sparse import csc_matrix

SLOT = INV * 0.5

m, d = load()
imp = d["imp"].to_numpy(); exp_ = d["exp"].to_numpy(); load_ = d["kwh"].to_numpy()
wall = d["start_local"].dt.strftime("%Y-%m-%d %H:%M").tolist()
days = [w[:10] for w in wall]
T = len(imp)
sc = SC_P_DAY * T / 48 / 100
base = float((load_ * imp).sum()) / 100
cfg = m.Cfg(argparse.Namespace(capacity=CAP, round_trip=EFF, inverter_kw=INV,
                               total_import_limit_kw=None, max_charge_price=None,
                               export_limit_kw=None))
midnight = [i for i in range(1, T) if days[i] != days[i - 1]]
M = np.array([0] + midnight)          # slot index of each day's 00:00
ND = len(M)


def stats(label, profit, chg):
    add = EFF * chg
    roll = np.convolve(add, np.ones(48), mode="valid")
    tot = base - profit / 100 + sc
    print(f"{label:<52} £{tot:8,.2f}  max roll {roll.max():5.2f} kWh  "
          f"windows>32 {(roll > 32 + 1e-6).sum()}")
    return tot, roll


def fixed_point(start_bounds, clamp=None, iters=12, tag=""):
    bounds, prev = list(start_bounds), None
    for it in range(1, iters + 1):
        profit, chg, edges, first_chg = solve_groups(m, cfg, imp, exp_, load_, bounds)
        raw = sorted(first_chg.values())
        if clamp is not None:
            lo_off, hi_off = clamp   # slots relative to that day's midnight
            new = []
            for b in raw:
                dd = np.searchsorted(M, b, side="right") - 1
                new.append(int(np.clip(b, M[dd] + lo_off, M[dd] + hi_off)))
            new = sorted(set(new))
        else:
            new = raw
        if new == prev:
            print(f"  [{tag}] converged at iteration {it}")
            break
        prev, bounds = new, new
    profit, chg, edges, _ = solve_groups(m, cfg, imp, exp_, load_, bounds)
    return profit, chg, edges


# ---- baseline: variant A unconstrained ----
profitA, chgA, edgesA = fixed_point(midnight, tag="A")
stats("A) fixed point on charge start (baseline)", profitA, chgA)

# ---- E1: bounded offset from 24h cadence ----
p1, c1, e1 = fixed_point(midnight, clamp=(-6, 36), tag="E1 -3h..+18h")
stats("E1) bounded offset midnight+[-3h,+18h]", p1, c1)

# ---- E2: seed from each day's cheapest slot ----
cheapest = []
for dd in range(ND):
    a, b = M[dd], M[dd + 1] if dd + 1 < ND else T
    cheapest.append(int(a + np.argmin(imp[a:b])))
p2, c2, e2 = fixed_point(cheapest, tag="E2 trough seed")
stats("E2) fixed point seeded from price trough", p2, c2)


# ---- E3: post-hoc LP filter on violating chains ----
def seg_lp(a, b, fixed_add):
    """LP over slots [a,b): soc=0 at both ends, rolling 24h charge cap incl. fixed
    charge outside the segment. Returns (profit_pence, charge_kwh_per_slot)."""
    n_ = b - a
    n = 4 * n_
    C, DL, DE, S = 0, n_, 2 * n_, 3 * n_
    li, lo_v, le = imp[a:b], load_[a:b], exp_[a:b]
    obj = np.zeros(n)
    obj[C:C + n_] = li; obj[DL:DL + n_] = -li; obj[DE:DE + n_] = -le
    rows, cols, vals, beq = [], [], [], []
    r = 0
    for t in range(n_):
        rows += [r, r, r, r]; cols += [S + t, C + t, DL + t, DE + t]
        vals += [1.0, -EFF, 1.0, 1.0]
        if t > 0:
            rows.append(r); cols.append(S + t - 1); vals.append(-1.0)
        beq.append(0.0); r += 1
    rows.append(r); cols.append(S + n_ - 1); vals.append(1.0); beq.append(0.0); r += 1
    Aeq = csc_matrix((vals, (rows, cols)), shape=(r, n))
    # rolling cap: for every window [w, w+48) overlapping [a,b)
    r2, c2_, v2, b2 = [], [], [], []
    ri = 0
    for w in range(max(0, a - 47), min(T - 48, b - 1) + 1):
        we = w + 48
        inside = range(max(w, a), min(we, b))
        out = fixed_add[w:we].sum() - fixed_add[max(w, a):min(we, b)].sum()
        for t in inside:
            r2.append(ri); c2_.append(C + (t - a)); v2.append(EFF)
        b2.append(CAP - out)
        ri += 1
    # shared inverter: dl + de <= SLOT
    for t in range(n_):
        r2 += [ri, ri]; c2_ += [DL + t, DE + t]; v2 += [1.0, 1.0]; ri += 1
        b2.append(SLOT)
    Aub = csc_matrix((v2, (r2, c2_)), shape=(ri, n))
    lo = np.zeros(n); hi = np.empty(n)
    hi[C:C + n_] = SLOT
    hi[DL:DL + n_] = np.minimum(lo_v, SLOT)
    hi[DE:DE + n_] = SLOT
    hi[S:S + n_] = CAP
    res = linprog(obj, A_ub=Aub, b_ub=np.array(b2), A_eq=Aeq, b_eq=np.array(beq),
                  bounds=list(zip(lo, hi)), method="highs")
    if not res.success:
        raise RuntimeError(res.message)
    return -res.fun, res.x[C:C + n_]


addA = EFF * chgA
rollA = np.convolve(addA, np.ones(48), mode="valid")
viol = np.where(rollA > CAP + 1e-6)[0]
# affected slot spans -> merge -> snap to group edges
spans = []
for w in viol:
    s, e = w, w + 48
    if spans and s <= spans[-1][1]:
        spans[-1][1] = max(spans[-1][1], e)
    else:
        spans.append([s, e])
ed = np.array(edgesA)
segs = []
for s, e in spans:
    a = ed[np.searchsorted(ed, s, side="right") - 1]
    b = ed[min(np.searchsorted(ed, e, side="left"), len(ed) - 1)]
    if segs and a <= segs[-1][1]:
        segs[-1][1] = max(segs[-1][1], b)
    else:
        segs.append([int(a), int(b)])
print(f"\nE3: {len(viol)} violating windows -> {len(segs)} segments "
      f"({sum(b-a for a,b in segs)} slots, {sum(b-a for a,b in segs)/48:.0f} days)")

# per-group profit for untouched groups
per_grp = []
for gi in range(len(ed) - 1):
    a, b = ed[gi], ed[gi + 1]
    if b - a < 2:
        per_grp.append(0.0); continue
    r = m.solve_day(imp[a:b].tolist(), exp_[a:b].tolist(), load_[a:b].tolist(),
                    cfg, "scattered", True)
    per_grp.append(r["profit"])

in_seg = np.zeros(len(ed) - 1, bool)
for a, b in segs:
    for gi in range(len(ed) - 1):
        if ed[gi] >= a and ed[gi + 1] <= b:
            in_seg[gi] = True

fixed_add = addA.copy()
for a, b in segs:
    fixed_add[a:b] = 0.0   # segment charge becomes an LP variable

profit3 = sum(p for gi, p in enumerate(per_grp) if not in_seg[gi])
chg3 = chgA.copy()
for a, b in segs:
    chg3[a:b] = 0.0
for a, b in segs:
    p_seg, c_seg = seg_lp(a, b, fixed_add)
    profit3 += p_seg
    chg3[a:b] = c_seg
tot3, roll3 = stats("E3) post-hoc LP filter on violating chains", profit3, chg3)
print("\nreference: shipped £703.22 | A unconstrained £680.63 | "
      "carryover+rolling-cap LP £671.39")
