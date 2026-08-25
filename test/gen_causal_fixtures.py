#!/usr/bin/env python3
"""Regenerate test/causal_fixture.json from the Python reference. Deterministic."""
import datetime
import json
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


# (name, params, export-price multiplier). expMul > 1/0.6 lifts export ABOVE import,
# which is the regime where a greedy pairer wants to import and export in the SAME slot;
# the planner's one-meter XOR rule forbids it, so parity has to cover that branch too.
CASES = [
    ('scattered-export',  dict(cycle='scattered',  allowExport=True,  exportLimitKw=None, maxChargePrice=None), 1.0),
    ('contig-noexport',   dict(cycle='contiguous', allowExport=False, exportLimitKw=None, maxChargePrice=None), 1.0),
    ('scattered-capped',  dict(cycle='scattered',  allowExport=True,  exportLimitKw=3.0,  maxChargePrice=20.0), 1.0),
    ('scattered-exphigh', dict(cycle='scattered',  allowExport=True,  exportLimitKw=None, maxChargePrice=None), 2.2),
    ('contig-exphigh',    dict(cycle='contiguous', allowExport=True,  exportLimitKw=None, maxChargePrice=None), 2.2),
]
BASE = dict(capacity=12.0, roundTrip=0.9, dischargeFloorPct=10, inverterKw=5.0,
            totalImportLimitKw=None, useBattery=True)

if __name__ == '__main__':
    out = []
    for name, extra, exp_mul in CASES:
        usage, load, imp, exp = synth(35, seed=42)
        exp = [round(v * exp_mul, 4) for v in exp]
        params = {**BASE, **extra}
        slots, replans, warmup = run_replay(usage, load, imp, exp, make_cfg(params), params)
        out.append({'meta': {'name': name}, 'usage': usage, 'load': load, 'imp': imp,
                    'exp': exp, 'params': params,
                    'expected': {'slots': [{'cin': s['cin'], 'dl': s['dl'],
                                            'dx': s['dx'], 'soc': s['soc']} for s in slots],
                                 'replans': replans}})
    with open('causal_fixture.json', 'w') as f:
        json.dump(out, f)
    print(f"wrote {len(out)} cases")
