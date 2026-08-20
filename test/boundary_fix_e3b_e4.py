#!/usr/bin/env python3
"""Follow-ups to exp_fixes.py.

E3 gave £691.36 with 0 violations but its segment LP lets soc run continuously across
group boundaries inside a segment -- a relaxation the browser's per-group greedy cannot
match. Close that gap:

E3b  same post-hoc segment LP, but soc pinned to 0 at every interior group edge --
     the honest optimum for any per-group (separable) implementation under the cap
E4   sequential greedy with allowance repair: solve groups left-to-right with the
     shipped solver; if a group's fill breaches the rolling 24h cap given charge already
     committed, shrink that group's allowance (capacity) by the excess and re-solve.
     Directly portable to js/optimiser.js.
"""
import sys
sys.path.insert(0, "/home/anthonynash/src/energy-battery-sim/test")
from adaptive_boundary import load, solve_groups, CAP, EFF, INV, SC_P_DAY
import argparse

import numpy as np
from scipy.optimize import linprog
from scipy.sparse import csc_matrix

SLOT = INV * 0.5

m, d = load()
imp = d["imp"].to_numpy(); exp_ = d["exp"].to_numpy(); load_ = d["kwh"].to_numpy()
days = [w[:10] for w in d["start_local"].dt.strftime("%Y-%m-%d %H:%M").tolist()]
T = len(imp)
sc = SC_P_DAY * T / 48 / 100
base = float((load_ * imp).sum()) / 100


def mkcfg(cap):
    return m.Cfg(argparse.Namespace(capacity=cap, round_trip=EFF, inverter_kw=INV,
                                    total_import_limit_kw=None, max_charge_price=None,
                                    export_limit_kw=None))


cfg = mkcfg(CAP)
midnight = [i for i in range(1, T) if days[i] != days[i - 1]]


def stats(label, profit, chg):
    add = EFF * chg
    roll = np.convolve(add, np.ones(48), mode="valid")
    tot = base - profit / 100 + sc
    print(f"{label:<52} £{tot:8,.2f}  max roll {roll.max():5.2f} kWh  "
          f"windows>32 {(roll > 32 + 1e-6).sum()}")
    return tot


# converged variant A boundaries
bounds, prev = list(midnight), None
for _ in range(12):
    profitA, chgA, edgesA, first_chg = solve_groups(m, cfg, imp, exp_, load_, bounds)
    new = sorted(first_chg.values())
    if new == prev:
        break
    prev, bounds = new, new
profitA, chgA, edgesA, _ = solve_groups(m, cfg, imp, exp_, load_, bounds)
stats("A) baseline (converged charge-start fixed point)", profitA, chgA)
ed = np.array(edgesA)
addA = EFF * chgA


def seg_lp(a, b, fixed_add, interior_edges):
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
    for e in list(interior_edges) + [b]:
        rows.append(r); cols.append(S + (e - a) - 1); vals.append(1.0)
        beq.append(0.0); r += 1
    Aeq = csc_matrix((vals, (rows, cols)), shape=(r, n))
    r2, c2_, v2, b2 = [], [], [], []
    ri = 0
    for w in range(max(0, a - 47), min(T - 48, b - 1) + 1):
        we = w + 48
        out = fixed_add[w:we].sum() - fixed_add[max(w, a):min(we, b)].sum()
        for t in range(max(w, a), min(we, b)):
            r2.append(ri); c2_.append(C + (t - a)); v2.append(EFF)
        b2.append(CAP - out)
        ri += 1
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


# ---- E3b: post-hoc LP with interior soc=0 ----
roll = np.convolve(addA, np.ones(48), mode="valid")
viol = np.where(roll > CAP + 1e-6)[0]
spans = []
for w in viol:
    s, e = w, w + 48
    if spans and s <= spans[-1][1]:
        spans[-1][1] = max(spans[-1][1], e)
    else:
        spans.append([s, e])
segs = []
for s, e in spans:
    a = ed[np.searchsorted(ed, s, side="right") - 1]
    b = ed[min(np.searchsorted(ed, e, side="left"), len(ed) - 1)]
    if segs and a <= segs[-1][1]:
        segs[-1][1] = max(segs[-1][1], b)
    else:
        segs.append([int(a), int(b)])

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
    fixed_add[a:b] = 0.0
profit3b = sum(p for gi, p in enumerate(per_grp) if not in_seg[gi])
chg3b = chgA.copy()
for a, b in segs:
    chg3b[a:b] = 0.0
for a, b in segs:
    interior = [int(e) for e in ed if a < e < b]
    p_seg, c_seg = seg_lp(a, b, fixed_add, interior)
    profit3b += p_seg
    chg3b[a:b] = c_seg
stats("E3b) post-hoc LP, soc=0 at interior group edges", profit3b, chg3b)

# ---- E4: sequential greedy with allowance repair ----
committed = np.zeros(T)
profit4 = 0.0
chg4 = np.zeros(T)
repaired = 0
for gi in range(len(ed) - 1):
    a, b = int(ed[gi]), int(ed[gi + 1])
    if b - a < 2:
        continue
    allowance = CAP
    for attempt in range(10):
        r = m.solve_day(imp[a:b].tolist(), exp_[a:b].tolist(), load_[a:b].tolist(),
                        mkcfg(allowance), "scattered", True)
        tmp = committed.copy()
        for n_l, k in r["charge"].items():
            tmp[a + n_l] += k * EFF
        w0, w1 = max(0, a - 47), min(T - 48, b - 1) + 1
        rr = np.convolve(tmp[w0:w1 + 47], np.ones(48), mode="valid")
        excess = rr.max() - CAP
        if excess <= 1e-9 or allowance <= 1e-9:
            break
        allowance = max(0.0, allowance - excess)
        repaired += attempt == 0
    profit4 += r["profit"]
    for n_l, k in r["charge"].items():
        committed[a + n_l] += k * EFF
        chg4[a + n_l] = k
stats(f"E4) sequential greedy, allowance repair ({repaired} grps)", profit4, chg4)

print("\nreference: shipped £703.22 | A £680.63 | E3 relaxed LP £691.36 | "
      "rolling-cap LP £671.39")
