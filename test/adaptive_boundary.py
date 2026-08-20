#!/usr/bin/env python3
"""
Does redefining the "day" as charge-cycle-start to next charge-cycle-start recover the
carryover benefit while keeping the fast, separable per-group solver?

The shipped model cuts at calendar midnight and forces soc=0 there, which dumps the pack
every night. Cutting instead at the moment charging begins makes soc=0 physically correct
at the boundary, lets the discharge phase run right up to the next charge window, and makes
two fills per group impossible.

The charge window's position is an OUTPUT of the optimisation, so two ways to get a boundary:
  A) fixed point -- solve, read each group's actual first charging slot, re-cut, repeat
  B) price-derived -- cut at each calendar day's cheapest slot (no circularity, trivially
     implementable in the browser)

Reference points from the LPs, same inputs (region J, 32 kWh, 10 kW, Agile + Agile Outgoing):
  calendar-day reset (shipped)        £703.22
  carryover, calendar cycle cap       £647.13   (permits 2 cycles/24h -- flawed)
  carryover, rolling 24h cap          £671.39   (honest full-foresight target)
  rolling horizon, realistic 16:00    £661.63

  python3 test/adaptive_boundary.py
"""
import argparse
import importlib.util
import sys

import numpy as np

CLI = "/home/anthonynash/Downloads/agile-battery-sim.py"
USAGE = "/home/anthonynash/Downloads/octopus-usage.csv"
PRICES = "/home/anthonynash/Downloads/prices-agile-J.csv"
CAP, EFF, INV = 32.0, 0.90, 10.0
SC_P_DAY = 55.78566


def load():
    spec = importlib.util.spec_from_file_location("sim", CLI)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    d = m.load(USAGE, PRICES)
    return m, d


def solve_groups(m, cfg, imp, exp, load_, bounds, mode="scattered", allow_export=True):
    """bounds = sorted slot indices where a new group starts. Returns per-slot detail."""
    T = len(imp)
    edges = sorted(set([0] + [b for b in bounds if 0 < b < T] + [T]))
    profit = 0.0
    chg = np.zeros(T)
    first_chg = {}
    for gi in range(len(edges) - 1):
        a, b = edges[gi], edges[gi + 1]
        if b - a < 2:
            continue
        r = m.solve_day(imp[a:b].tolist(), exp[a:b].tolist(), load_[a:b].tolist(),
                        cfg, mode, allow_export)
        profit += r["profit"]
        for n, kwh in r["charge"].items():
            chg[a + n] = kwh
        if r["charge"]:
            first_chg[gi] = a + min(r["charge"])
    return profit, chg, edges, first_chg


def report(label, m, cfg, imp, exp, load_, bounds, sc, base):
    profit, chg, edges, _ = solve_groups(m, cfg, imp, exp, load_, bounds)
    energy = base - profit / 100
    add = EFF * chg
    roll = np.convolve(add, np.ones(48), mode="valid")
    lens = np.diff(edges) * 0.5
    print(f"{label:<44} total £{energy + sc:9,.2f}  "
          f"max rolling 24h charge {roll.max():5.2f} kWh  "
          f"groups {len(edges)-1}, length {lens.min():.1f}-{lens.max():.1f}h "
          f"(mean {lens.mean():.1f})")
    return energy + sc, roll.max()


if __name__ == "__main__":
    m, d = load()
    imp = d["imp"].to_numpy(); exp = d["exp"].to_numpy(); load_ = d["kwh"].to_numpy()
    wall = d["start_local"].dt.strftime("%Y-%m-%d %H:%M").tolist()
    days = [w[:10] for w in wall]
    hours = np.array([int(w[11:13]) + int(w[14:16]) / 60 for w in wall])
    T = len(imp)
    sc = SC_P_DAY * T / 48 / 100
    base = float((load_ * imp).sum()) / 100
    cfg = m.Cfg(argparse.Namespace(capacity=CAP, round_trip=EFF, inverter_kw=INV,
                                   total_import_limit_kw=None, max_charge_price=None,
                                   export_limit_kw=None))
    print(f"{T} slots, standing charge £{sc:,.2f}, no-battery energy £{base:,.2f}\n")

    # baseline: calendar midnight (what the app ships)
    midnight = [i for i in range(1, T) if days[i] != days[i - 1]]
    report("calendar midnight (shipped)", m, cfg, imp, exp, load_, midnight, sc, base)

    # B) price-derived: cut at each calendar day's cheapest slot
    cheapest = []
    for dd in sorted(set(days)):
        ix = [i for i in range(T) if days[i] == dd]
        cheapest.append(min(ix, key=lambda i: imp[i]))
    report("B) cut at each day's cheapest slot", m, cfg, imp, exp, load_,
           cheapest, sc, base)

    # A) fixed point on the actual charge start
    bounds = list(midnight)
    prev = None
    for it in range(1, 9):
        profit, chg, edges, first_chg = solve_groups(m, cfg, imp, exp, load_, bounds)
        new = sorted(first_chg.values())
        moved = 0 if prev is None else sum(1 for a, b in zip(prev, new) if a != b)
        tot, rmax = report(f"A) fixed point, iteration {it}", m, cfg, imp, exp, load_,
                           new, sc, base)
        if prev is not None and new == prev:
            print(f"    converged at iteration {it}")
            break
        prev, bounds = new, new
    print("\nreference: shipped £703.22 | carryover+rolling-cap LP £671.39 | "
          "rolling-horizon LP £661.63")


def enforce_spacing(bounds, min_slots, T):
    """Charge starts must be >= min_slots apart, or two fills land inside one 24h window."""
    out = []
    for b in sorted(bounds):
        if not out or b - out[-1] >= min_slots:
            out.append(b)
    return [b for b in out if 0 < b < T]


def fixed_point(m, cfg, imp, exp, load_, T, start_bounds, min_slots, iters=8):
    bounds, prev = list(start_bounds), None
    for _ in range(iters):
        _, _, _, first_chg = solve_groups(m, cfg, imp, exp, load_, bounds)
        new = enforce_spacing(sorted(first_chg.values()), min_slots, T)
        if new == prev:
            break
        prev, bounds = new, new
    return bounds
