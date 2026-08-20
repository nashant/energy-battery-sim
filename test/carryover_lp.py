#!/usr/bin/env python3
"""
Exact LP benchmark for relaxing the daily energy-balance rule.

The shipped optimiser solves each day independently and forces state of charge back to 0
at every day boundary, so leftover energy gets dumped rather than carried into the next
morning. This measures what that costs, and separates it from the other restriction in
the shipped model (all charging must precede all discharging within a day).

Four models, all with the same power/capacity limits:
  A  daily reset + charge-before-discharge   (what the app does today; greedy)
  B  daily reset, ordering free              (LP, soc forced to 0 each midnight)
  C  carryover, ordering free                (LP, soc continuous all year)
  D  carryover, no daily throughput cap      (LP; upper bound, breaks one-cycle/day)

"One cycle per day" is expressed as: kWh delivered into the battery per day <= usable
capacity. That caps throughput at one equivalent full cycle daily, which is what actually
protects cycle life -- unlike forcing soc to zero, which does not.

  python3 test/carryover_lp.py [prices.csv] [inverter_kw]
"""
import sys
from collections import defaultdict

import numpy as np
from scipy.optimize import linprog
from scipy.sparse import csc_matrix

sys.path.insert(0, "/home/anthonynash/Downloads")

CAP = 32.0
EFF = 0.90
INV = float(sys.argv[2]) if len(sys.argv) > 2 else 10.0
SLOT = INV * 0.5


def load_inputs(price_csv):
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "sim", "/home/anthonynash/Downloads/agile-battery-sim.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    d = m.load("/home/anthonynash/Downloads/octopus-usage.csv", price_csv)
    day = d["start_local"].dt.strftime("%Y-%m-%d").tolist()
    return (d["kwh"].to_numpy(), d["imp"].to_numpy(), d["exp"].to_numpy(), day, m, d)


def solve_lp(load, imp, exp, day, carryover, cycle_cap=True):
    """Variables per slot: c (grid->batt), dl (batt->load), de (batt->export), soc."""
    T = len(load)
    n = 4 * T
    C, DL, DE, S = 0, T, 2 * T, 3 * T

    # objective: (load - dl + c)*imp - de*exp ; the constant load*imp is added back later
    obj = np.zeros(n)
    obj[C:C + T] = imp
    obj[DL:DL + T] = -imp
    obj[DE:DE + T] = -exp

    rows, cols, vals, beq = [], [], [], []
    r = 0
    # soc[t] - soc[t-1] - eff*c[t] + dl[t] + de[t] = 0
    for t in range(T):
        rows += [r, r, r, r]
        cols += [S + t, C + t, DL + t, DE + t]
        vals += [1.0, -EFF, 1.0, 1.0]
        if t > 0:
            rows.append(r); cols.append(S + t - 1); vals.append(-1.0)
        elif carryover:
            # start the year empty; the year is long enough that this hardly matters
            pass
        beq.append(0.0)
        r += 1
    # daily boundary: force soc to 0 at each day end unless carrying over
    if not carryover:
        last = {}
        for t, dd in enumerate(day):
            last[dd] = t
        for t in last.values():
            rows.append(r); cols.append(S + t); vals.append(1.0)
            beq.append(0.0)
            r += 1
    Aeq = csc_matrix((vals, (rows, cols)), shape=(r, n))

    # one equivalent full cycle per day: sum(eff*c) over the day <= CAP
    Aub, bub = None, None
    if cycle_cap:
        idx = defaultdict(list)
        for t, dd in enumerate(day):
            idx[dd].append(t)
        rows2, cols2, vals2, bub_l = [], [], [], []
        for i, (dd, ts) in enumerate(sorted(idx.items())):
            for t in ts:
                rows2.append(i); cols2.append(C + t); vals2.append(EFF)
            bub_l.append(CAP)
        Aub = csc_matrix((vals2, (rows2, cols2)), shape=(len(bub_l), n))
        bub = np.array(bub_l)

    lo = np.zeros(n)
    hi = np.empty(n)
    hi[C:C + T] = SLOT                      # charge power
    hi[DL:DL + T] = np.minimum(load, SLOT)  # cannot discharge more load than exists
    hi[DE:DE + T] = SLOT                    # export power (shared cap enforced below)
    hi[S:S + T] = CAP

    # dl[t] + de[t] <= SLOT  (inverter shared between load and export)
    rows3, cols3, vals3 = [], [], []
    for t in range(T):
        rows3 += [t, t]; cols3 += [DL + t, DE + t]; vals3 += [1.0, 1.0]
    Ashare = csc_matrix((vals3, (rows3, cols3)), shape=(T, n))
    if Aub is None:
        Aub, bub = Ashare, np.full(T, SLOT)
    else:
        from scipy.sparse import vstack
        Aub = vstack([Aub, Ashare], format="csc")
        bub = np.concatenate([bub, np.full(T, SLOT)])

    res = linprog(obj, A_ub=Aub, b_ub=bub, A_eq=Aeq, b_eq=np.array(beq),
                  bounds=list(zip(lo, hi)), method="highs")
    if not res.success:
        raise RuntimeError(res.message)
    base = float((load * imp).sum())
    energy_p = base + res.fun
    x = res.x
    return dict(energy=energy_p / 100,
                charged=float(EFF * x[C:C + T].sum()),
                exported=float(x[DE:DE + T].sum()),
                to_load=float(x[DL:DL + T].sum()),
                soc_end_max=float(max(x[S + t] for t in _day_ends(day))),
                soc=x[S:S + T])


def _day_ends(day):
    last = {}
    for t, dd in enumerate(day):
        last[dd] = t
    return list(last.values())


if __name__ == "__main__":
    price_csv = sys.argv[1] if len(sys.argv) > 1 else "/home/anthonynash/Downloads/prices-agile-J.csv"
    load, imp, exp, day, m, d = load_inputs(price_csv)
    sc = 55.78566 * len(load) / 48 / 100
    print(f"{price_csv.split('/')[-1]}  inverter {INV:g} kW  cap {CAP:g} kWh  "
          f"{len(load)} slots\nstanding charge £{sc:,.2f}\n")

    # A: the shipped greedy model
    import argparse
    cfg = m.Cfg(argparse.Namespace(capacity=CAP, round_trip=EFF, inverter_kw=INV,
                                   total_import_limit_kw=None, max_charge_price=None,
                                   export_limit_kw=None))
    dd = d.assign(k=d["start_local"].dt.strftime("%Y-%m-%d"))
    res = [m.solve_day(g.imp.tolist(), g.exp.tolist(), g.kwh.tolist(), cfg, "scattered", True)
           for _, g in dd.groupby("k")]
    base = float((load * imp).sum()) / 100
    a_energy = base - sum(x["profit"] for x in res) / 100
    a_out = sum(x["kwh_out"] for x in res)
    print(f"A  daily reset + charge-before-discharge (shipped)  energy £{a_energy:8,.2f}  "
          f"total £{a_energy + sc:8,.2f}  cycled {a_out:,.0f} kWh")

    for label, carry, cap in (("B  daily reset, ordering free            ", False, True),
                              ("C  CARRYOVER, ordering free              ", True, True),
                              ("D  carryover, no daily cycle cap         ", True, False)):
        r = solve_lp(load, imp, exp, day, carryover=carry, cycle_cap=cap)
        print(f"{label}  energy £{r['energy']:8,.2f}  total £{r['energy'] + sc:8,.2f}  "
              f"charged {r['charged']:,.0f} kWh  exported {r['exported']:,.0f}  "
              f"to load {r['to_load']:,.0f}  max soc at midnight {r['soc_end_max']:.1f} kWh")


# ---------------------------------------------------------------- rolling horizon
def solve_rolling(load, imp, exp, localwall, epoch_hour=16):
    """Realistic-foresight simulation.

    Agile publishes at ~16:00 for a day ending 23:00, so at each 16:00 you know prices
    through to 23:00 tomorrow (~31h). Decide with that horizon, commit the next 24h,
    carry state of charge forward, then re-plan. The daily one-cycle allowance is tracked
    per calendar day across windows so a rolling window cannot spend it twice.
    """
    T = len(load)
    hours = np.array([int(w[11:13]) for w in localwall])
    mins = np.array([int(w[14:16]) for w in localwall])
    days = [w[:10] for w in localwall]

    # decision epochs: every local 16:00
    epochs = [t for t in range(T) if hours[t] == epoch_hour and mins[t] == 0]
    soc0 = 0.0
    used = defaultdict(float)
    cost_p = 0.0
    committed_charge = np.zeros(T)
    committed_dl = np.zeros(T)
    committed_de = np.zeros(T)

    for i, e in enumerate(epochs):
        # horizon runs to 23:00 on the day after the next epoch
        nxt = epochs[i + 1] if i + 1 < len(epochs) else T
        h_end = nxt
        while h_end < T and not (hours[h_end] == 23 and mins[h_end] == 0):
            h_end += 1
        h_end = min(h_end, T)
        if e >= h_end:
            break
        sl = slice(e, h_end)
        r = _window_lp(load[sl], imp[sl], exp[sl], days[e:h_end], soc0, used)
        commit_n = min(nxt, h_end) - e
        c, dl, de = r["c"][:commit_n], r["dl"][:commit_n], r["de"][:commit_n]
        committed_charge[e:e + commit_n] = c
        committed_dl[e:e + commit_n] = dl
        committed_de[e:e + commit_n] = de
        for k in range(commit_n):
            used[days[e + k]] += EFF * c[k]
        soc0 = soc0 + float((EFF * c - dl - de).sum())

    grid = load - committed_dl + committed_charge
    cost_p = float((grid * imp).sum() - (committed_de * exp).sum())
    return dict(energy=cost_p / 100, charged=float(EFF * committed_charge.sum()),
                exported=float(committed_de.sum()), to_load=float(committed_dl.sum()),
                covered=int(np.count_nonzero(committed_charge)))


def _window_lp(load, imp, exp, days, soc0, used):
    T = len(load)
    n = 4 * T
    C, DL, DE, S = 0, T, 2 * T, 3 * T
    obj = np.zeros(n)
    obj[C:C + T] = imp; obj[DL:DL + T] = -imp; obj[DE:DE + T] = -exp
    rows, cols, vals, beq = [], [], [], []
    for t in range(T):
        rows += [t, t, t, t]; cols += [S + t, C + t, DL + t, DE + t]
        vals += [1.0, -EFF, 1.0, 1.0]
        if t > 0:
            rows.append(t); cols.append(S + t - 1); vals.append(-1.0)
        beq.append(soc0 if t == 0 else 0.0)
    Aeq = csc_matrix((vals, (rows, cols)), shape=(T, n))
    # remaining daily allowance per calendar day touched by this window
    idx = defaultdict(list)
    for t, dd in enumerate(days):
        idx[dd].append(t)
    r2, c2, v2, b2 = [], [], [], []
    for i, (dd, ts) in enumerate(sorted(idx.items())):
        for t in ts:
            r2.append(i); c2.append(C + t); v2.append(EFF)
        b2.append(max(0.0, CAP - used.get(dd, 0.0)))
    for t in range(T):
        r2 += [len(b2) + t, len(b2) + t]; c2 += [DL + t, DE + t]; v2 += [1.0, 1.0]
    Aub = csc_matrix((v2, (r2, c2)), shape=(len(b2) + T, n))
    bub = np.concatenate([np.array(b2), np.full(T, SLOT)])
    lo = np.zeros(n); hi = np.empty(n)
    hi[C:C + T] = SLOT
    hi[DL:DL + T] = np.minimum(load, SLOT)
    hi[DE:DE + T] = SLOT
    hi[S:S + T] = CAP
    res = linprog(obj, A_ub=Aub, b_ub=bub, A_eq=Aeq, b_eq=np.array(beq),
                  bounds=list(zip(lo, hi)), method="highs")
    if not res.success:
        raise RuntimeError(res.message)
    x = res.x
    return dict(c=x[C:C + T], dl=x[DL:DL + T], de=x[DE:DE + T])
