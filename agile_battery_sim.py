#!/usr/bin/env python3
"""
Agile Octopus cost + battery arbitrage simulator.

Compares, over the period covered by the two CSVs:
  [0] what you actually paid on your current tariff (from the usage CSV's cost column)
  [1] what you'd have paid on Agile with no battery
  [2] what you'd have paid on Agile with a battery, one charge/discharge cycle per day

Model
-----
* Capacity is USABLE (deliverable) energy. Round-trip efficiency is applied on the
  way in: 1 kWh imported -> `--round-trip` kWh deliverable. So a full charge of a
  32 kWh / 90% battery imports 32/0.9 = 35.56 kWh.
* Inverter power limits both charge and discharge per half-hour slot
  (6 kW -> 3 kWh in, 3 kWh out). Discharge to load + export share that limit.
* By default the inverter limit applies to battery charging only, so grid import in
  a charge slot is house load + battery charge. Use --total-import-limit-kw to cap
  total grid import instead.
* ONE cycle per day: all charging strictly precedes all discharging; battery starts
  and ends each day empty. That last part is an energy-balance constraint -- every
  kWh charged must be discharged the same day. It matters: without it, the optimiser
  "charges" 32 kWh through negative-price slots to collect the payment and lets the
  energy evaporate, which is worth real money and is not physical.
* Perfect foresight of the day's prices (Agile publishes day-ahead, so a real
  scheduler genuinely has this).

Cycle modes
-----------
  contiguous  charge at full inverter power across one unbroken run of slots
              ("charge 01:00-07:00"), then discharge only. Definitively one cycle.
  scattered   charge in any set of slots (cheapest ones), as long as all charging
              finishes before any discharging starts. Still one cycle, slightly better.

Export
------
  --no-export   battery only offsets house load (value of 1 kWh out = avoided import price)
  --export      after covering load, surplus is exported at the Agile export price

Examples
--------
  ./agile-battery-sim.py --all
  ./agile-battery-sim.py --cycle scattered --export
  ./agile-battery-sim.py --cycle contiguous --export --day 2026-01-08
"""
import argparse
import sys

try:
    import pandas as pd
except ImportError:
    sys.exit("needs pandas: python3 -m venv venv && ./venv/bin/pip install pandas")


# ---------------------------------------------------------------- data loading

def load(usage_csv, price_csv):
    u = pd.read_csv(usage_csv, skipinitialspace=True)
    u.columns = [c.strip() for c in u.columns]
    u = u.rename(columns={"Consumption (kwh)": "kwh",
                          "Estimated Cost Inc. Tax (p)": "actual_p",
                          "Standing Charge Inc. Tax (p)": "sc_p"})
    u["start_local"] = pd.to_datetime(u["Start"], utc=True).dt.tz_convert("Europe/London")
    # match on local wall-clock: the price CSV is local time with no offset
    u["wall"] = u["start_local"].dt.strftime("%Y-%m-%d %H:%M")

    a = pd.read_csv(price_csv)
    a.columns = [c.strip() for c in a.columns]
    a = a.rename(columns={c: ("imp" if "Import" in c else "exp" if "Export" in c else c)
                          for c in a.columns})
    a["wall"] = pd.to_datetime(a["Period from"],
                               format="%d/%m/%Y %H:%M").dt.strftime("%Y-%m-%d %H:%M")

    # The autumn DST day has two 01:00-02:00 local hours. A price file listing both
    # would give a duplicate wall-clock key and silently MULTIPLY usage rows in the
    # merge below, inflating every total. Keep one and say so.
    dup = int(a["wall"].duplicated().sum())
    if dup:
        print(f"note: {dup} duplicate wall-clock price rows (DST repeated hour); "
              f"keeping the first of each.", file=sys.stderr)
        a = a.drop_duplicates(subset="wall", keep="first")

    d = (u.merge(a[["wall", "imp", "exp"]], on="wall", how="left")
           .sort_values("start_local").reset_index(drop=True))
    missing = int(d["imp"].isna().sum())
    if missing:
        print(f"WARNING: {missing}/{len(d)} usage slots had no matching price; dropped.",
              file=sys.stderr)
        d = d.dropna(subset=["imp"]).reset_index(drop=True)
    return d


# ------------------------------------------------------------------- day solver

class Cfg:
    def __init__(self, args):
        self.cap = args.capacity
        self.eff = args.round_trip
        self.slot_in = args.inverter_kw * 0.5          # kWh imported into battery / slot
        self.slot_out = args.inverter_kw * 0.5         # kWh delivered out / slot
        self.chg_step = self.slot_in * self.eff        # deliverable added per full slot
        self.import_cap = (args.total_import_limit_kw * 0.5
                           if args.total_import_limit_kw else None)
        # only charge in slots at or below this import price (p/kWh)
        self.max_chg_p = getattr(args, "max_charge_price", None)
        if self.max_chg_p is None:
            self.max_chg_p = float("inf")
        # Separate cap on EXPORT power, independent of inverter size. A DNO may approve a
        # large inverter for charging/self-supply while limiting grid export -- e.g. holding
        # export to 3.68 kW keeps a single-phase install inside G98 notification.
        elk = getattr(args, "export_limit_kw", None)
        self.export_slot = (elk * 0.5) if elk else self.slot_out

    def charge_in_slot(self, load_t):
        """Max kWh the battery can take from the grid in one slot."""
        if self.import_cap is None:
            return self.slot_in
        return max(0.0, min(self.slot_in, self.import_cap - load_t))


def discharge_buckets(imp, exp, load, s, allow_export, cfg):
    """Marginal value of discharging, slots s..end, best first, per-slot cap applied.
    Returns list of (p_per_kWh, kWh, slot, kind)."""
    raw = []
    for t in range(s, len(imp)):
        raw.append((imp[t], min(load[t], cfg.slot_out), t, "load"))
        if allow_export:
            # export is bounded by its own cap as well as by the inverter; the per-slot
            # `rem` accounting below still holds load+export within cfg.slot_out
            raw.append((exp[t], min(cfg.slot_out, cfg.export_slot), t, "export"))
    raw.sort(key=lambda b: -b[0])
    rem, out = {}, []
    for val, qty, t, kind in raw:
        cap = rem.get(t, cfg.slot_out)
        q = min(qty, cap)
        if q <= 1e-12:
            continue
        rem[t] = cap - q
        out.append((val, q, t, kind))
    return out


def cum_all(buckets):
    """Cumulative (qty, value) over ALL buckets, best-value first.

    Not truncated at value<=0: under the energy-balance rule below, energy that has
    been charged must be discharged, even into a slot where that is worth little or
    (at a negative import price) actually costs money.
    """
    qs, vs = [0.0], [0.0]
    for val, q, _, _ in buckets:
        qs.append(qs[-1] + q)
        vs.append(vs[-1] + val * q)
    return qs, vs


def value_for(qs, vs, E):
    """Value of discharging exactly E kWh. None if the window can't absorb E
    (energy balance: everything charged must be discharged the same day)."""
    if E <= 0:
        return 0.0
    if E > qs[-1] + 1e-9:
        return None
    for i in range(1, len(qs)):
        if qs[i] >= E - 1e-12:
            span = qs[i] - qs[i - 1]
            frac = (E - qs[i - 1]) / span if span > 1e-12 else 0.0
            return vs[i - 1] + (vs[i] - vs[i - 1]) * frac
    return vs[-1]


def take_discharge(buckets, E):
    """Allocate exactly E kWh to the best-value buckets, in value order."""
    got, alloc = 0.0, {}
    left = E
    for val, q, t, kind in buckets:
        if left <= 1e-12:
            break
        x = min(q, left)
        alloc.setdefault(t, {"load": 0.0, "export": 0.0})[kind] += x
        got += val * x
        left -= x
    return got, alloc


def solve_day(imp, exp, load, cfg, mode, allow_export):
    """Best one-cycle schedule. Returns dict with profit (pence) and per-slot plan."""
    T = len(imp)
    buckets = {s: discharge_buckets(imp, exp, load, s, allow_export, cfg)
               for s in range(T + 1)}
    cums = {s: cum_all(b) for s, b in buckets.items()}
    best = {"profit": 0.0, "charge": {}, "discharge": {}, "kwh_out": 0.0,
            "imported": 0.0, "cost_p": 0.0, "gain_p": 0.0, "window": None}

    if mode == "contiguous":
        # Slots needed for a full charge. chg_step is the UNCONSTRAINED per-slot step;
        # with --total-import-limit-kw the real per-slot room is smaller, so capping the
        # window at cap/chg_step would stop short of ever filling the battery. Only take
        # the cheap bound when charging is genuinely unconstrained.
        if cfg.import_cap is not None or cfg.chg_step <= 0:
            max_L = T
        else:
            max_L = int(cfg.cap / cfg.chg_step) + 2
        for i in range(T):
            for L in range(1, min(max_L, T - i) + 1):
                if imp[i + L - 1] > cfg.max_chg_p:
                    break          # this slot is too dear; no longer window helps either
                rem, cost, chg = cfg.cap, 0.0, {}
                for t in range(i, i + L):
                    room = cfg.charge_in_slot(load[t]) * cfg.eff
                    add = min(room, rem)
                    if add <= 1e-12:
                        continue
                    cost += (add / cfg.eff) * imp[t]
                    chg[t] = add / cfg.eff          # kWh imported
                    rem -= add
                E = cfg.cap - rem
                if E <= 1e-9:
                    continue
                gain = value_for(*cums[i + L], E)
                if gain is None:          # window can't absorb this much charge
                    continue
                if gain - cost > best["profit"] + 1e-9:
                    best = {"profit": gain - cost, "charge": chg, "kwh_out": E,
                            "imported": E / cfg.eff, "cost_p": cost, "gain_p": gain,
                            "window": (i, i + L - 1), "_s": i + L}
    else:
        for s in range(1, T + 1):
            cand = sorted(((imp[t] / cfg.eff, t) for t in range(s)
                           if imp[t] <= cfg.max_chg_p), key=lambda x: x[0])
            dis = buckets[s]
            ci = di = 0
            c_left = cfg.charge_in_slot(load[cand[0][1]]) * cfg.eff if cand else 0.0
            d_left = dis[0][1] if dis else 0.0
            soc, profit, cost, gain, E, chg = cfg.cap, 0.0, 0.0, 0.0, 0.0, {}
            while ci < len(cand) and di < len(dis) and soc > 1e-9:
                c_cost, ct = cand[ci]
                d_val = dis[di][0]
                if d_val <= c_cost + 1e-12:
                    break
                q = min(c_left, d_left, soc)
                if q > 1e-12:
                    profit += (d_val - c_cost) * q
                    cost += c_cost * q
                    gain += d_val * q
                    E += q
                    soc -= q
                    c_left -= q
                    d_left -= q
                    chg[ct] = chg.get(ct, 0.0) + q / cfg.eff
                if c_left <= 1e-12:
                    ci += 1
                    c_left = (cfg.charge_in_slot(load[cand[ci][1]]) * cfg.eff
                              if ci < len(cand) else 0.0)
                if d_left <= 1e-12:
                    di += 1
                    d_left = dis[di][1] if di < len(dis) else 0.0
            if profit > best["profit"] + 1e-9:
                best = {"profit": profit, "charge": chg, "kwh_out": E,
                        "imported": E / cfg.eff, "cost_p": cost, "gain_p": gain,
                        "window": (min(chg), max(chg)) if chg else None, "_s": s}

    if best["kwh_out"] > 0:
        _, alloc = take_discharge(buckets[best["_s"]], best["kwh_out"])
        best["discharge"] = alloc
    return best


# ---------------------------------------------------------------------- driving

def day_key(d, boundary):
    if boundary == "midnight":
        return d["start_local"].dt.strftime("%Y-%m-%d")
    return (d["start_local"] + pd.Timedelta(hours=1)).dt.strftime("%Y-%m-%d")


def simulate(d, cfg, mode, allow_export, boundary, only_day=None):
    d = d.assign(k=day_key(d, boundary))
    rows, sched = [], None
    for k, g in d.groupby("k", sort=True):
        if only_day and k != only_day:
            continue
        imp, exp, load = g["imp"].tolist(), g["exp"].tolist(), g["kwh"].tolist()
        r = solve_day(imp, exp, load, cfg, mode, allow_export)
        base = sum(l * p for l, p in zip(load, imp))
        rows.append(dict(day=k, baseline_p=base, profit_p=r["profit"],
                         cost_p=base - r["profit"], kwh=sum(load),
                         kwh_out=r["kwh_out"], imported=r["imported"],
                         charge_cost_p=r["cost_p"], gain_p=r["gain_p"],
                         used=r["kwh_out"] > 1e-9))
        if only_day:
            sched = (g.reset_index(drop=True), r)
    return pd.DataFrame(rows), sched


def print_schedule(g, r, cfg, allow_export):
    print(f"{'slot':>6} {'import p':>9} {'export p':>9} {'load':>7} "
          f"{'chg in':>7} {'->load':>7} {'->exp':>7} {'grid':>8} {'soc':>6} {'£ slot':>9}")
    print("-" * 92)
    soc = 0.0
    tot_base = tot_new = 0.0
    for i, row in g.iterrows():
        cin = r["charge"].get(i, 0.0)
        dd = r["discharge"].get(i, {"load": 0.0, "export": 0.0})
        dl, de = dd["load"], dd["export"]
        soc += cin * cfg.eff - dl - de
        grid = row.kwh + cin - dl                      # +import
        slot_cost = grid * row.imp - de * row.exp      # pence
        tot_base += row.kwh * row.imp
        tot_new += slot_cost
        mark = " <<CHG" if cin > 1e-9 else (" >>DIS" if (dl + de) > 1e-9 else "")
        print(f"{row.start_local.strftime('%H:%M'):>6} {row.imp:9.2f} {row.exp:9.2f} "
              f"{row.kwh:7.3f} {cin:7.3f} {dl:7.3f} {de:7.3f} {grid:8.3f} {soc:6.2f} "
              f"{slot_cost/100:9.3f}{mark}")
    print("-" * 92)
    print(f"  day load {g.kwh.sum():.2f} kWh | battery in {r['imported']:.2f} kWh "
          f"-> out {r['kwh_out']:.2f} kWh"
          + (f" | charge window {g.start_local.iloc[r['window'][0]].strftime('%H:%M')}"
             f"-{(g.start_local.iloc[r['window'][1]] + pd.Timedelta(minutes=30)).strftime('%H:%M')}"
             if r["window"] else " | battery unused"))
    print(f"  no battery: £{tot_base/100:.2f}   with battery: £{tot_new/100:.2f}   "
          f"saving £{r['profit']/100:.2f}")


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--usage", default="octopus-usage.csv")
    p.add_argument("--prices", default="agile-octopus.csv")
    p.add_argument("--cycle", choices=["contiguous", "scattered"], default="contiguous",
                   help="how strictly one-cycle-per-day is enforced (default: contiguous)")
    ex = p.add_mutually_exclusive_group()
    ex.add_argument("--export", dest="export", action="store_true",
                    help="allow exporting surplus at Agile export prices")
    ex.add_argument("--no-export", dest="export", action="store_false",
                    help="self-consumption only (default)")
    p.set_defaults(export=False)
    p.add_argument("--all", action="store_true",
                   help="run all four cycle x export combinations")
    p.add_argument("--capacity", type=float, default=32.0, help="usable kWh (default 32)")
    p.add_argument("--round-trip", type=float, default=0.90,
                   help="round-trip efficiency, applied on charge (default 0.90)")
    p.add_argument("--inverter-kw", type=float, default=6.0,
                   help="inverter charge/discharge power (default 6)")
    p.add_argument("--total-import-limit-kw", type=float, default=None,
                   help="cap TOTAL grid import (load+charge) instead of battery charge only")
    p.add_argument("--boundary", choices=["midnight", "agile"], default="midnight",
                   help="day boundary: local midnight, or the 23:00-23:00 Agile day")
    p.add_argument("--day", help="show the half-hourly schedule for one day (YYYY-MM-DD)")
    p.add_argument("--standing-charge-p", type=float, default=None,
                   help="CURRENT tariff daily standing charge in pence; "
                        "default uses the usage CSV's column")
    p.add_argument("--agile-standing-charge-p", type=float, default=None,
                   help="AGILE daily standing charge in pence inc VAT, which differs from "
                        "your current tariff's and is region-specific. Get it from "
                        "https://api.octopus.energy/v1/products/AGILE-24-10-01/"
                        "electricity-tariffs/E-1R-AGILE-24-10-01-<REGION>/standing-charges/ "
                        "(e.g. B=54.84696, J=55.78566). Defaults to the current tariff's, "
                        "which understates every Agile total.")
    p.add_argument("--export-limit-kw", "--g100-export-limit-kw", type=float, default=None,
                   metavar="KW", dest="export_limit_kw",
                   help="G100 Export Limitation: cap grid export power to the value agreed "
                        "with the DNO, independently of inverter size. This is the normal way "
                        "to run an inverter larger than your permitted export (e.g. a 10 kW "
                        "hybrid with export limited to 5 kW). Use 3.68 to sit inside G98 on "
                        "single phase. Default: export limited only by --inverter-kw")
    p.add_argument("--max-charge-price", type=float, default=None,
                   help="only charge in slots at or below this import price (p/kWh). "
                        "e.g. 0 = charge ONLY when prices are negative or free")
    p.add_argument("--monthly", action="store_true", help="print a monthly breakdown")
    p.add_argument("--out", help="write per-day results to this CSV")
    args = p.parse_args()

    d = load(args.usage, args.prices)
    cfg = Cfg(args)
    # Slot-derived day count, so a part-day at either end is pro-rated rather than
    # billed a full standing charge (the DST days' +2/-2 slots cancel over a year).
    ndays = len(d) / 48
    cal_days = d["start_local"].dt.strftime("%Y-%m-%d").nunique()
    sc = (args.standing_charge_p * ndays / 100 if args.standing_charge_p is not None
          else d.sc_p.sum() / 100)
    if args.agile_standing_charge_p is not None:
        agile_sc = args.agile_standing_charge_p * ndays / 100
    else:
        agile_sc = sc
        print("WARNING: no --agile-standing-charge-p given, so the current tariff's "
              "standing charge is being used for the Agile rows too. Agile's is "
              "region-specific and typically higher, which understates every Agile "
              "total below. Energy figures are unaffected.\n", file=sys.stderr)
    actual = d.actual_p.sum() / 100
    baseline = (d.kwh * d.imp).sum() / 100

    if args.day:
        df, sched = simulate(d, cfg, args.cycle, args.export, args.boundary, args.day)
        if sched is None:
            sys.exit(f"no data for day {args.day}")
        g, r = sched
        print(f"=== {args.day}  cycle={args.cycle}  export={'yes' if args.export else 'no'}  "
              f"{args.capacity:g} kWh usable @ {args.round_trip:.0%} RT, {args.inverter_kw:g} kW ===")
        print_schedule(g, r, cfg, args.export)
        return

    print(f"period {d.start_local.min():%Y-%m-%d %H:%M} -> {d.start_local.max():%Y-%m-%d %H:%M}"
          f"   {d.kwh.sum():,.0f} kWh over {ndays:.2f} days ({d.kwh.sum()/ndays:.1f} kWh/day"
          f", {len(d):,} slots across {cal_days} calendar days)")
    print(f"Agile import price: min {d.imp.min():.2f}p  mean {d.imp.mean():.2f}p  "
          f"max {d.imp.max():.2f}p   ({(d.imp<0).sum()} negative slots)")
    print(f"standing charges: current tariff £{sc:,.2f}   Agile £{agile_sc:,.2f}\n")
    print(f"[0] current tariff, no battery   energy £{actual:8,.2f}   total £{actual+sc:8,.2f}")
    print(f"[1] Agile, no battery            energy £{baseline:8,.2f}   total £{baseline+agile_sc:8,.2f}"
          f"   vs current £{(actual+sc)-(baseline+agile_sc):+,.2f}")

    combos = ([("contiguous", False), ("contiguous", True),
               ("scattered", False), ("scattered", True)] if args.all
              else [(args.cycle, args.export)])
    last = None
    for mode, ax in combos:
        df, _ = simulate(d, cfg, mode, ax, args.boundary)
        energy = baseline - df.profit_p.sum() / 100
        print(f"[2] Agile + battery {mode:10s} export={'yes' if ax else 'no ':3s} "
              f"energy £{energy:8,.2f}   total £{energy+agile_sc:8,.2f}"
              f"   vs Agile £{energy-baseline:+,.2f}"
              f"   vs current £{(energy+agile_sc)-(actual+sc):+,.2f}")
        print(f"      battery active {int(df.used.sum())}/{len(df)} days; "
              f"{df.imported.sum():,.0f} kWh in / {df.kwh_out.sum():,.0f} kWh out; "
              f"best day £{df.profit_p.max()/100:.2f}, median £{df.profit_p.median()/100:.2f}")
        last = df
        if args.out and len(combos) == 1:
            df.to_csv(args.out, index=False)

    if args.monthly and last is not None:
        m = last.assign(month=last.day.str[:7]).groupby("month").agg(
            kwh=("kwh", "sum"), no_bat=("baseline_p", "sum"), with_bat=("cost_p", "sum"),
            saved=("profit_p", "sum"))
        for c in ("no_bat", "with_bat", "saved"):
            m[c] = (m[c] / 100).round(2)
        print("\nmonthly (last scenario above):")
        print(m.to_string())


if __name__ == "__main__":
    main()
