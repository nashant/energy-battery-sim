#!/usr/bin/env python3
"""
Rolling-horizon battery benchmark with discharge strategies and late price publication.

Two things this adds over carryover_lp.py:

1. Publication timing. Octopus publishes Agile rates "between 4-8pm every day (usually
   nearer 4pm)" for a day ending 23:00. Lateness bites in a specific place: the 16:00-19:00
   evening peak is exactly when you'd choose between exporting hard and holding charge for
   tomorrow morning, and if tomorrow's prices have not landed you must decide blind.
   Publication times are drawn per day from a truncated exponential on [lo, hi] whose rate
   is solved so the SAMPLE MEDIAN matches the requested median.

2. Discharge strategies. Real inverters follow a rule, not an optimum. Three of the four
   are exact (bound manipulations); load-first is a documented linear relaxation.

  python3 test/strategies_lp.py [prices.csv] [inverter_kw]
"""
import argparse
import importlib.util
import math
import random
import sys
from collections import defaultdict

import numpy as np
from scipy.optimize import linprog
from scipy.sparse import csc_matrix, vstack

CAP, EFF = 32.0, 0.90
USAGE = "/home/anthonynash/Downloads/octopus-usage.csv"
CLI = "/home/anthonynash/Downloads/agile-battery-sim.py"

STRATEGIES = ("optimal", "load-first", "peak-export", "threshold")


def load_inputs(price_csv):
    spec = importlib.util.spec_from_file_location("sim", CLI)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    d = m.load(USAGE, price_csv)
    wall = d["start_local"].dt.strftime("%Y-%m-%d %H:%M").tolist()
    return (d["kwh"].to_numpy(), d["imp"].to_numpy(), d["exp"].to_numpy(), wall, m, d)


# ------------------------------------------------------------- publication timing

def _rate_for_median(median, lo, hi):
    """Rate of a truncated exponential on [lo,hi] whose median is `median`."""
    if median <= lo + 1e-9:
        return None                      # degenerate: always at lo
    m, L = median - lo, hi - lo
    if m >= L / 2:
        # median at or past the midpoint needs a left-skewed shape; mirror it
        return -_solve_rate(L - m, L)
    return _solve_rate(m, L)


def _solve_rate(m, L):
    """(1 - e^-km)/(1 - e^-kL) = 1/2. f is INCREASING in k, so f(mid)>0 means the root is
    below mid. Getting this direction wrong silently degenerates the draw to the endpoint."""
    f = lambda k: (1 - math.exp(-k * m)) / (1 - math.exp(-k * L)) - 0.5
    lo_k, hi_k = 1e-9, 1e3
    for _ in range(200):
        mid = (lo_k + hi_k) / 2
        if f(mid) > 0:
            hi_k = mid
        else:
            lo_k = mid
    return (lo_k + hi_k) / 2


def publication_hours(days, median_h, lo=16.0, hi=20.0, seed=7):
    """Per-day publication hour (float), drawn so the sample median ~= median_h."""
    rng = random.Random(seed)
    k = _rate_for_median(median_h, lo, hi)
    out = {}
    L = hi - lo
    for d in days:
        if k is None:
            out[d] = lo
            continue
        u = rng.random()
        if k > 0:
            x = -math.log(1 - u * (1 - math.exp(-k * L))) / k
        else:                             # mirrored, for medians past the midpoint
            kk = -k
            x = L - (-math.log(1 - u * (1 - math.exp(-kk * L))) / kk)
        out[d] = lo + min(L, max(0.0, x))
    return out


# ------------------------------------------------------------- window LP

def window_lp(load, imp, exp, days, hours, soc0, used, strat, slot):
    T = len(load)
    n = 4 * T
    C, DL, DE, S = 0, T, 2 * T, 3 * T
    obj = np.zeros(n)
    obj[C:C + T] = imp
    obj[DL:DL + T] = -imp
    obj[DE:DE + T] = -exp

    rows, cols, vals, beq = [], [], [], []
    for t in range(T):
        rows += [t, t, t, t]
        cols += [S + t, C + t, DL + t, DE + t]
        vals += [1.0, -EFF, 1.0, 1.0]
        if t > 0:
            rows.append(t); cols.append(S + t - 1); vals.append(-1.0)
        beq.append(soc0 if t == 0 else 0.0)
    Aeq = csc_matrix((vals, (rows, cols)), shape=(T, n))

    # remaining one-cycle-per-day allowance for each calendar day in this window
    idx = defaultdict(list)
    for t, dd in enumerate(days):
        idx[dd].append(t)
    r2, c2, v2, b2 = [], [], [], []
    for i, (dd, ts) in enumerate(sorted(idx.items())):
        for t in ts:
            r2.append(i); c2.append(C + t); v2.append(EFF)
        b2.append(max(0.0, CAP - used.get(dd, 0.0)))
    nrow = len(b2)
    # inverter shared between discharge-to-load and export
    for t in range(T):
        r2 += [nrow + t, nrow + t]; c2 += [DL + t, DE + t]; v2 += [1.0, 1.0]
    b2 += [slot] * T
    nrow += T

    lo = np.zeros(n)
    hi = np.empty(n)
    hi[C:C + T] = slot
    hi[DL:DL + T] = np.minimum(load, slot)
    hi[DE:DE + T] = slot
    hi[S:S + T] = CAP

    if strat.get("reserve_kwh"):
        # "reserve capacity to carry over": force at least R kWh still in the pack at each
        # 23:00 Agile-day boundary, instead of letting the optimiser choose the carryover
        for t in range(T):
            if abs(hours[t] - 23.0) < 1e-9:
                lo[S + t] = min(strat["reserve_kwh"], CAP)

    if strat["name"] == "peak-export":
        # export only inside the stated window; discharge to load stays free
        w0, w1 = strat["window"]
        for t in range(T):
            if not (w0 <= hours[t] < w1):
                hi[DE + t] = 0.0
    elif strat["name"] == "threshold":
        for t in range(T):
            if imp[t] < strat["min_import_p"]:
                hi[DL + t] = 0.0
            if exp[t] < strat["min_export_p"]:
                hi[DE + t] = 0.0
    elif strat["name"] == "load-first":
        # no export until house load is served from the battery.
        # exact at the endpoints: dl=0 forces de=0; dl=L_t leaves de unconstrained.
        # linear relaxation in between, so this is a lower bound on strictness.
        for t in range(T):
            L_t = min(load[t], slot)
            if L_t <= 1e-12:
                hi[DE + t] = 0.0 if load[t] > 0 else hi[DE + t]
                continue
            r2 += [nrow, nrow]; c2 += [DE + t, DL + t]; v2 += [L_t, -slot]
            b2.append(0.0)
            nrow += 1

    Aub = csc_matrix((v2, (r2, c2)), shape=(nrow, n))
    res = linprog(obj, A_ub=Aub, b_ub=np.array(b2), A_eq=Aeq, b_eq=np.array(beq),
                  bounds=list(zip(lo, hi)), method="highs")
    if not res.success:
        raise RuntimeError(res.message)
    x = res.x
    return x[C:C + T], x[DL:DL + T], x[DE:DE + T]


# ------------------------------------------------------------- rolling simulation

def solve_rolling(load, imp, exp, wall, pub_hours, strat, slot):
    T = len(load)
    days = [w[:10] for w in wall]
    hours = np.array([int(w[11:13]) + int(w[14:16]) / 60.0 for w in wall])

    # decision epoch = first slot at/after that day's publication hour
    epochs, seen = [], set()
    for t in range(T):
        d = days[t]
        if d not in seen and hours[t] >= pub_hours.get(d, 16.0):
            epochs.append(t); seen.add(d)
    # horizon end for an epoch on day d = 23:00 on day d+1
    end23 = {}
    for t in range(T):
        if abs(hours[t] - 23.0) < 1e-9:
            end23[days[t]] = t

    soc0, used = 0.0, defaultdict(float)
    c_all = np.zeros(T); dl_all = np.zeros(T); de_all = np.zeros(T)
    peak_lead = []   # hours of visibility past 19:00 when the evening peak was committed
    missed = [0]     # windows where a hard reserve floor was unreachable
    for i, e in enumerate(epochs):
        nxt = epochs[i + 1] if i + 1 < len(epochs) else T
        # newly published block runs to 23:00 tomorrow; find that index
        h_end = T
        for t in range(nxt, T):
            if abs(hours[t] - 23.0) < 1e-9:
                h_end = t
                break
        h_end = min(max(h_end, nxt), T)
        sl = slice(e, h_end)
        try:
            c, dl, de = window_lp(load[sl], imp[sl], exp[sl], days[e:h_end], hours[e:h_end],
                                  soc0, used, strat, slot)
        except RuntimeError:
            # a hard reserve floor is unreachable once the day's cycle allowance is spent;
            # a real inverter would simply miss the reserve rather than refuse to run
            relaxed = {k: v for k, v in strat.items() if k != "reserve_kwh"}
            c, dl, de = window_lp(load[sl], imp[sl], exp[sl], days[e:h_end], hours[e:h_end],
                                  soc0, used, relaxed, slot)
            missed[0] += 1
        k = min(nxt, h_end) - e
        c_all[e:e + k], dl_all[e:e + k], de_all[e:e + k] = c[:k], dl[:k], de[:k]
        for j in range(k):
            used[days[e + j]] += EFF * c[j]
        soc0 += float((EFF * c[:k] - dl[:k] - de[:k]).sum())
        # if this window contains an evening peak, how far beyond it could we see?
        for j in range(k):
            if abs(hours[e + j] - 16.0) < 1e-9:
                peak_lead.append((h_end - (e + j)) * 0.5 - 3.0)
                break

    grid = load - dl_all + c_all
    cost_p = float((grid * imp).sum() - (de_all * exp).sum())
    return dict(energy=cost_p / 100, charged=float(EFF * c_all.sum()),
                exported=float(de_all.sum()), to_load=float(dl_all.sum()),
                peak_lead_h=(sum(peak_lead) / len(peak_lead)) if peak_lead else 0.0,
                reserve_missed=missed[0])


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("prices", nargs="?", default="/home/anthonynash/Downloads/prices-agile-J.csv")
    ap.add_argument("inverter", nargs="?", type=float, default=10.0)
    ap.add_argument("--sc", type=float, default=55.78566)
    a = ap.parse_args()
    slot = a.inverter * 0.5

    load, imp, exp, wall, m, d = load_inputs(a.prices)
    days = sorted({w[:10] for w in wall})
    sc = a.sc * len(load) / 48 / 100
    print(f"{a.prices.split('/')[-1]}  inverter {a.inverter:g} kW  cap {CAP:g} kWh  "
          f"standing charge £{sc:,.2f}\n")

    strat_defs = {
        "optimal":     dict(name="optimal"),
        "load-first":  dict(name="load-first"),
        "peak-export": dict(name="peak-export", window=(16.0, 19.0)),
        "threshold":   dict(name="threshold", min_import_p=20.0, min_export_p=15.0),
    }

    print(f"{'strategy':<12} {'publish':<9} {'total':>10} {'exported':>9} {'to load':>8} "
          f"{'charged':>8}  peak lead")
    for sname, strat in strat_defs.items():
        for med in (16.0, 17.0, 18.0, 19.0):
            ph = publication_hours(days, med)
            realised = sorted(ph.values())
            med_actual = realised[len(realised) // 2]
            r = solve_rolling(load, imp, exp, wall, ph, strat, slot)
            print(f"{sname:<12} {med:>4.0f}:00   £{r['energy'] + sc:9,.2f} "
                  f"{r['exported']:9,.0f} {r['to_load']:8,.0f} {r['charged']:8,.0f}  "
                  f"{r['peak_lead_h']:>6.1f}h   (realised median {med_actual:.2f}h)")
