#!/usr/bin/env python3
"""Regenerate test/causal_fixture.json from the Python reference. Deterministic."""
import datetime
import json
import math
from causal_model import run_replay, make_cfg


def _utc(ms):
    """datetime for a ms epoch, UTC — JS `new Date(ms)` rendered as UTC."""
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.UTC)


def lcg(seed):
    s = seed
    while True:
        s = (s * 48271) % 2147483647
        yield s / 2147483647


def synth(days, seed):
    rnd = lcg(seed)
    wall, lf, load, imp, exp = [], [], [], [], []
    t0 = 1736121600000  # 2025-01-06T00:00Z, a Monday
    for d in range(days):
        for s in range(48):
            ms = t0 + (d * 48 + s) * 1800000
            # fixed-offset wall clock, matching JS Date UTC rendering
            wall.append(_utc(ms).strftime('%Y-%m-%dT%H:%M'))
            lf.append(ms)
            hh = s / 2
            we = _utc(ms).weekday() >= 5
            load.append(round((0.2 + (0.6 if 17 <= hh < 21 else 0)) * (1.25 if we else 1)
                              * (0.8 + 0.4 * next(rnd)), 6))
            base = 12 if hh < 6 else 38 if 16 <= hh < 19 else 24
            imp.append(round(base * (0.9 + 0.2 * next(rnd)), 4))
            exp.append(round(base * 0.6 * (0.9 + 0.2 * next(rnd)), 4))
    return {'wall': wall, 'localFloat': lf}, load, imp, exp


def synth_pv(days, seed, kwp=4.0):
    """Bell-shaped PV with a per-day cloud factor; forecasts are the actual with day-level noise."""
    rnd = lcg(seed)
    T = days * 48
    actual, f1, f2 = [], [], []
    for d in range(days):
        cloud = 0.3 + 0.7 * next(rnd)
        n1 = 0.75 + 0.5 * next(rnd)
        n2 = 0.6 + 0.8 * next(rnd)
        for s in range(48):
            hh = s / 2
            bell = math.sin(math.pi * (hh - 6) / 12) ** 1.5 if 6 < hh < 18 else 0.0
            v = round(kwp * 0.4 * bell * cloud, 6)          # kWh per half hour
            actual.append(v)
            f1.append(round(v * n1, 6))
            f2.append(round(v * n2, 6))
    return actual, f1, f2


# (name, params, export-price multiplier). expMul > 1/0.6 lifts export ABOVE import,
# which is the regime where a greedy pairer wants to import and export in the SAME slot;
# the planner's one-meter XOR rule forbids it, so parity has to cover that branch too.
CASES = [
    ('scattered-export',  dict(cycle='scattered',  allowExport=True,  exportLimitKw=None, maxChargePrice=None), 1.0),
    ('contig-noexport',   dict(cycle='contiguous', allowExport=False, exportLimitKw=None, maxChargePrice=None), 1.0),
    ('scattered-capped',  dict(cycle='scattered',  allowExport=True,  exportLimitKw=3.0,  maxChargePrice=20.0), 1.0),
    ('scattered-exphigh', dict(cycle='scattered',  allowExport=True,  exportLimitKw=None, maxChargePrice=None), 2.2),
    ('contig-exphigh',    dict(cycle='contiguous', allowExport=True,  exportLimitKw=None, maxChargePrice=None), 2.2),
    # planner options (each default-off switch exercised at least once)
    ('contig-holdlater',  dict(cycle='contiguous', allowExport=True,  exportLimitKw=None, maxChargePrice=None,
                               holdFor='laterCheaperRefill'), 1.0),
    ('scattered-refill',  dict(cycle='scattered',  allowExport=True,  exportLimitKw=None, maxChargePrice=None,
                               holdFor='laterCheaperRefill', packEnergyWorth='refillCost'), 1.0),
    ('contig-known48',    dict(cycle='contiguous', allowExport=True,  exportLimitKw=None, maxChargePrice=None,
                               priceHorizon='knownSchedule48h', replanEvery=2), 1.0),
    ('scattered-never',   dict(cycle='scattered',  allowExport=True,  exportLimitKw=3.0,  maxChargePrice=None,
                               holdFor='never', packEnergyWorth='refillCost'), 1.0),
    # cycle wear: 3500*100/(6000*10.8) = 5.4 p per pack-kWh, enough to prune thin spreads
    ('contig-wear',       dict(cycle='contiguous', allowExport=True,  exportLimitKw=None, maxChargePrice=None,
                               batteryCost=3500.0, cycleLife=6000), 1.0),
    ('scattered-wear',    dict(cycle='scattered',  allowExport=True,  exportLimitKw=None, maxChargePrice=None,
                               batteryCost=3500.0, cycleLife=6000, packEnergyWorth='refillCost'), 1.0),
    ('contig-pv-ac',      dict(cycle='contiguous', allowExport=True,  exportLimitKw=None, maxChargePrice=None,
                               packEnergyWorth='refillCost'), 1.0, 'ac'),
    ('scattered-pv-dc',   dict(cycle='scattered',  allowExport=True,  exportLimitKw=3.0,  maxChargePrice=None), 1.0, 'dc'),
    ('contig-pv-noexp',   dict(cycle='contiguous', allowExport=False, exportLimitKw=None, maxChargePrice=None), 1.0, 'ac'),
    # a 1.2 kW hybrid inverter under a 6 kWp DC array: PV alone overflows it (peaks ~2.4
    # kWh/half-hour vs 0.6) and the synthetic load tops 0.6 in ~35 daytime slots, so the
    # clip lands while discharge to the house is still on the inverter — the give-back
    # branch (overflow off discharge before it clips PV) fires in ~70 slots
    ('scattered-pv-dc-big', dict(cycle='scattered', allowExport=True, exportLimitKw=None, maxChargePrice=None,
                                 inverterKw=1.2), 1.0, 'dc', 6.0),
]
BASE = dict(capacity=12.0, roundTrip=0.9, dischargeFloorPct=10, inverterKw=5.0,
            totalImportLimitKw=None, useBattery=True)

if __name__ == '__main__':
    out = []
    for name, extra, exp_mul, *pvc in CASES:
        usage, load, imp, exp = synth(35, seed=42)
        exp = [round(v * exp_mul, 4) for v in exp]
        params = {**BASE, **extra}
        pv = None
        if pvc:
            a, f1, f2 = synth_pv(35, seed=7, kwp=pvc[1] if len(pvc) > 1 else 4.0)
            z = [0.0] * len(a)
            pv = ({'ac': a, 'dc': z, 'acF1': f1, 'acF2': f2, 'dcF1': z, 'dcF2': z} if pvc[0] == 'ac'
                  else {'ac': z, 'dc': a, 'acF1': z, 'acF2': z, 'dcF1': f1, 'dcF2': f2})
        slots, replans, warmup = run_replay(usage, load, imp, exp, make_cfg(params), params, pv)
        out.append({'meta': {'name': name}, 'usage': usage, 'load': load, 'imp': imp,
                    'exp': exp, 'params': params, 'pv': pv,
                    'expected': {'slots': [{'cin': s['cin'], 'dl': s['dl'], 'dx': s['dx'],
                                            'soc': s['soc'], 'pvc': s['pvc'], 'pvx': s['pvx']}
                                            for s in slots],
                                 'replans': replans}})
    with open('causal_fixture.json', 'w') as f:
        json.dump(out, f)
    print(f"wrote {len(out)} cases")
