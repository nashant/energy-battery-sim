#!/usr/bin/env python3
"""Python reference for the causal engine — a line-for-line transcription of
js/optimiser.js (primitives), js/causal.js (Forecaster + solveHorizon) and
runReplay from js/data.js.

Parity with the JS is float-exact by construction: the same float operations in
the same order, the same stable sorts with the same tie-breaks, the same
division operand order. Anything that reads as a gratuitous rewrite here is
deliberate mirroring. Stdlib only.

Deliberate JS->Python translations (JS semantics that don't survive naively):
  * `a ?? b` / `x || 0`     -> explicit None checks (0 must survive).
  * `if (dd)` on an object  -> `if dd is not None` (a dict of zeros is falsy in
                               Python, an object is always truthy in JS).
  * `p ? p[s] : 0` on array -> `p is None` check (an empty list is falsy in
                               Python, an empty array is truthy in JS).
  * `arr.sort((a,b)=>b.val-a.val)`      -> `sort(key=lambda b: -b['val'])`
                               (both sorts are stable, so ties keep insertion order).
  * `sort((a,b)=>a.cost-b.cost||a.t-b.t)` -> `sort(key=lambda c: (c['cost'], c['t']))`.
  * `new Date(ms).toISOString().slice(0,10)` -> UTC strftime, see `_iso_date`.
  * `new Date(d+'T12:00:00Z').getUTCDay()` in {0,6} -> `weekday() >= 5`.
"""

import datetime
import math

EPS = 1e-12
MARGIN = 1e-9
INF = math.inf

FORECAST_DEFAULTS = {'alpha': 0.15, 'lambdaFull': 0.75, 'rampSlots': 16, 'warmupDays': 14}


def _iso_date(ms):
    """new Date(ms).toISOString().slice(0, 10)"""
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.UTC).strftime('%Y-%m-%d')


# ---------------------------------------------------------------- js/optimiser.js

def make_cfg(p):
    inv_slot = p['inverterKw'] * 0.5
    floor = min(max(p.get('dischargeFloorPct'), 0), 95) / 100 if p.get('dischargeFloorPct') else 0
    mcp = p.get('maxChargePrice')
    return {
        'cap': p['capacity'] * (1 - floor),
        'reserve': p['capacity'] * floor,
        'eff': p['roundTrip'],
        'slotIn': inv_slot,
        'slotOut': inv_slot,
        'chgStep': inv_slot * p['roundTrip'],
        'importCap': p['totalImportLimitKw'] * 0.5 if p.get('totalImportLimitKw') else None,
        'maxChgP': INF if mcp is None or mcp == '' else float(mcp),
        'exportSlot': p['exportLimitKw'] * 0.5 if p.get('exportLimitKw') else inv_slot,
    }


def charge_in_slot(cfg, load_t):
    if cfg['importCap'] is None:
        return cfg['slotIn']
    return max(0, min(cfg['slotIn'], cfg['importCap'] - load_t))


def discharge_buckets(imp, exp, load, s, allow_export, cfg):
    raw = []
    for t in range(s, len(imp)):
        lq = min(load[t], cfg['slotOut'])
        raw.append({'val': imp[t], 'qty': lq, 't': t, 'kind': 'load'})
        if allow_export:
            room = cfg['slotOut'] - lq if exp[t] > imp[t] else cfg['slotOut']
            raw.append({'val': exp[t], 'qty': min(room, cfg['exportSlot']), 't': t,
                        'kind': 'export'})
    raw.sort(key=lambda b: -b['val'])        # stable desc, matching JS's stable sort
    rem = {}
    out = []
    for b in raw:
        cap = rem[b['t']] if b['t'] in rem else cfg['slotOut']
        q = min(b['qty'], cap)
        if q <= 1e-12:
            continue
        rem[b['t']] = cap - q
        out.append({'val': b['val'], 'qty': q, 't': b['t'], 'kind': b['kind']})
    return out


def cum_all(buckets):
    qs, vs = [0], [0]
    for b in buckets:
        qs.append(qs[len(qs) - 1] + b['qty'])
        vs.append(vs[len(vs) - 1] + b['val'] * b['qty'])
    return {'qs': qs, 'vs': vs}


def value_for(cum, E):
    qs, vs = cum['qs'], cum['vs']
    if E <= 0:
        return 0
    if E > qs[len(qs) - 1] + 1e-9:
        return None
    for i in range(1, len(qs)):
        if qs[i] >= E - 1e-12:
            span = qs[i] - qs[i - 1]
            frac = (E - qs[i - 1]) / span if span > 1e-12 else 0
            return vs[i - 1] + (vs[i] - vs[i - 1]) * frac
    return vs[len(vs) - 1]


def take_discharge(buckets, E):
    left, got = E, 0
    alloc = {}
    for b in buckets:
        if left <= 1e-12:
            break
        x = min(b['qty'], left)
        if b['t'] not in alloc:
            alloc[b['t']] = {'load': 0, 'export': 0}
        alloc[b['t']][b['kind']] += x
        got += b['val'] * x
        left -= x
    return {'got': got, 'alloc': alloc}


# ------------------------------------------------------------------- js/causal.js

class Forecaster:
    def __init__(self, opts=None):
        o = {**FORECAST_DEFAULTS, **(opts or {})}
        self.alpha = o['alpha']
        self.lambdaFull = o['lambdaFull']
        self.rampSlots = o['rampSlots']
        self.profiles = {'wd': None, 'we': None}
        self.daysSeen = {'wd': 0, 'we': 0}
        self.todayActual = 0
        self.todayExpected = 0
        self.slotsElapsed = 0

    @staticmethod
    def day_type(date_str):
        # JS: new Date(dateStr + 'T12:00:00Z').getUTCDay() in {0 (Sun), 6 (Sat)}
        return 'we' if datetime.datetime.strptime(date_str, '%Y-%m-%d').weekday() >= 5 else 'wd'

    def base(self, type_, s):
        p = self.profiles[type_]
        if p is None:
            p = self.profiles['we' if type_ == 'wd' else 'wd']
        if p is None:
            return 0
        if s < 0 or s >= len(p) or p[s] is None:
            return 0
        return p[s]

    def ratio(self):
        if self.slotsElapsed == 0 or self.todayExpected <= 1e-9:
            return 1
        r = self.todayActual / self.todayExpected
        lam = self.lambdaFull * min(1, self.slotsElapsed / self.rampSlots)
        return 1 + lam * (r - 1)

    def forecast(self, entries, today_date):
        r = self.ratio()
        out = []
        for e in entries:
            b = self.base(Forecaster.day_type(e['date']), e['slotOfDay'])
            out.append(b * r if e['date'] == today_date else b)
        return out

    def settle(self, date, slot_of_day, actual_kwh):
        self.todayExpected += self.base(Forecaster.day_type(date), slot_of_day)
        self.todayActual += actual_kwh
        self.slotsElapsed += 1

    def complete_day(self, date, actual_by_slot):
        type_ = Forecaster.day_type(date)
        if self.profiles[type_] is None:
            self.profiles[type_] = [0 if v is None else v for v in actual_by_slot]
        else:
            prof = self.profiles[type_]
            new = []
            for s in range(len(prof)):
                v = prof[s]
                a = actual_by_slot[s]
                new.append(v if a is None else self.alpha * a + (1 - self.alpha) * v)
            self.profiles[type_] = new
        self.daysSeen[type_] += 1
        self.todayActual = 0
        self.todayExpected = 0
        self.slotsElapsed = 0


def _min_over(L, a, b):
    m = INF
    for t in range(a, b):
        m = min(m, L[t])
    return m


def _max_over(L, a, b):
    m = -INF
    for t in range(a, b):
        m = max(m, L[t])
    return m


def _add_range(L, a, b, q):
    for t in range(a, b):
        L[t] += q


def solve_horizon(soc0, imp, exp, load_f, cfg, mode, allow_export):
    T = len(imp)
    L = [min(soc0, cfg['cap'])] * T
    chg = {}                                       # t -> grid-side kWh
    dis_raw = {}                                   # t -> pack-side kWh out (pre-netting)
    slot_rem = [cfg['slotOut']] * T

    buckets = [dict(b) for b in
               discharge_buckets(imp, exp, load_f, 0, allow_export, cfg)]

    def commit(b, q):
        dis_raw[b['t']] = dis_raw.get(b['t'], 0) + q
        _add_range(L, b['t'], T, -q)
        slot_rem[b['t']] -= q
        b['qty'] -= q

    # Pass 1: spend the energy already in the pack on the best-value slots anywhere.
    for b in buckets:
        if b['val'] <= MARGIN:
            break
        q = min(b['qty'], slot_rem[b['t']], _min_over(L, b['t'], T))
        if q > EPS:
            commit(b, q)

    # Pass 2: matched charge->discharge pairs, best spread first, trajectory-feasible.
    if mode == 'contiguous':
        _contiguous_pass(L, chg, dis_raw, slot_rem, imp, exp, load_f, cfg, allow_export)
    else:
        cand = []
        for t in range(T):
            if imp[t] <= cfg['maxChgP']:
                cand.append({'t': t, 'cost': imp[t] / cfg['eff'],
                             'room': charge_in_slot(cfg, load_f[t])})
        cand.sort(key=lambda c: (c['cost'], c['t']))
        for b in buckets:
            if b['qty'] <= EPS or b['val'] <= MARGIN:
                continue
            for c in cand:
                if b['qty'] <= EPS:
                    break
                if b['val'] <= c['cost'] + MARGIN:
                    break                          # cand sorted: nothing cheaper left
                if c['room'] <= EPS or c['t'] >= b['t']:
                    continue
                head = cfg['cap'] - _max_over(L, c['t'], b['t'])
                q = min(b['qty'], slot_rem[b['t']], c['room'] * cfg['eff'], head)
                if q <= EPS:
                    continue
                chg[c['t']] = chg.get(c['t'], 0) + q / cfg['eff']
                c['room'] -= q / cfg['eff']
                _add_range(L, c['t'], T, q)
                commit(b, q)

    # Netting: within each slot, output covers forecast load before export.
    discharge = {}
    for t, tot in dis_raw.items():
        load = min(load_f[t], tot)
        discharge[t] = {'load': load, 'export': tot - load if allow_export else 0}
    ts = list(chg.keys())
    return {'chg': chg, 'discharge': discharge, 'plannedSoc': L,
            'window': [min(ts), max(ts)] if ts else None}


def _contiguous_pass(L, chg, dis_raw, slot_rem, imp, exp, load_f, cfg, allow_export):
    T = len(imp)

    def buckets_from(s):
        out = []
        for b in discharge_buckets(imp, exp, load_f, s, allow_export, cfg):
            committed = dis_raw.get(b['t'], 0)
            base = (max(0, min(load_f[b['t']], cfg['slotOut']) - committed)
                    if b['kind'] == 'load' else b['qty'])
            nb = dict(b)
            nb['qty'] = min(base, slot_rem[b['t']])
            out.append(nb)
        return [b for b in out if b['qty'] > EPS]

    best = None
    for i in range(T):
        for length in range(1, T - i + 1):
            if imp[i + length - 1] > cfg['maxChgP']:
                break
            head = cfg['cap'] - _max_over(L, i, i + length)
            if head <= EPS:
                continue
            bk = buckets_from(i + length)
            absorbable = 0
            for b in bk:
                absorbable = absorbable + b['qty']
            target = min(head, absorbable)
            if target <= MARGIN:
                continue
            rem, cost = target, 0
            w = {}
            for t in range(i, i + length):
                add = min(charge_in_slot(cfg, load_f[t]) * cfg['eff'], rem)
                if add <= EPS:
                    continue
                cost += (add / cfg['eff']) * imp[t]
                w[t] = add / cfg['eff']
                rem -= add
            E = target - rem
            if E <= MARGIN:
                continue
            gain = value_for(cum_all(bk), E)
            if gain is None:
                continue
            if best is None or gain - cost > best['profit'] + MARGIN:
                best = {'profit': gain - cost, 'w': w, 'E': E, 's': i + length}
    if best is None or best['profit'] <= MARGIN:
        return
    for t, q in best['w'].items():
        chg[t] = chg.get(t, 0) + q
    pack_in = best['E']
    first = min(best['w'].keys())
    _add_range(L, first, T, pack_in)
    alloc = take_discharge(buckets_from(best['s']), pack_in)['alloc']
    for t, dd in alloc.items():
        q = dd['load'] + dd['export']
        dis_raw[t] = dis_raw.get(t, 0) + q
        _add_range(L, t, T, -q)
        slot_rem[t] -= q


# --------------------------------------------------------- js/data.js (runReplay)

def day_keys(usage, boundary):
    shift = 3600000 if boundary == 'agile' else 0      # 23:00->23:00 local day
    return [_iso_date(t + shift) for t in usage['localFloat']]


PUBLISH_HHMM = '16:00'


def slot_of_day(wall):
    hh = int(wall[11:13])
    mm = int(wall[14:16])
    return hh * 2 + (1 if mm >= 30 else 0)


def run_replay(usage, load, imp, exp, cfg, params):
    T = len(load)
    mode = params.get('cycle') or 'contiguous'
    allow_export = bool(params.get('allowExport'))
    agile_key = day_keys(usage, 'agile')               # tariff-day (23:00-23:00)
    cal_key = [w[0:10] for w in usage['wall']]
    day_end = {}
    for i in range(T):
        day_end[agile_key[i]] = i + 1

    fc = Forecaster()
    slots = [None] * T
    soc = 0
    replans = 0
    plan = None
    plan_start = 0
    horizon = day_end[agile_key[0]]
    day_buf = [None] * 48

    def replan_at(i, h):
        nonlocal plan, plan_start, horizon, replans
        entries = [{'date': cal_key[t], 'slotOfDay': slot_of_day(usage['wall'][t])}
                   for t in range(i, h)]
        load_f = fc.forecast(entries, cal_key[i])
        plan = solve_horizon(soc, imp[i:h], exp[i:h], load_f, cfg, mode, allow_export)
        plan_start = i
        horizon = h
        replans += 1

    if params.get('useBattery') is not False:
        replan_at(0, horizon)

    for i in range(T):
        # publication: first slot of each calendar day at/after 16:00 extends the horizon
        # to the end of the NEXT tariff-day; the new plan takes effect from the NEXT slot.
        publishes = (params.get('useBattery') is not False
                     and usage['wall'][i][11:16] >= PUBLISH_HHMM
                     and (i == 0 or usage['wall'][i - 1][11:16] < PUBLISH_HHMM
                          or cal_key[i - 1] != cal_key[i]))

        # execute the active plan against ACTUAL load
        cin, dl, dx, planned_soc = 0, 0, 0, None
        if plan is not None and i >= plan_start and i < horizon:
            n = i - plan_start
            room = charge_in_slot(cfg, load[i])        # import cap vs ACTUAL load
            cin = min(plan['chg'].get(n, 0), room, (cfg['cap'] - soc) / cfg['eff'])
            dd = plan['discharge'].get(n)
            if dd is not None:
                q = min(dd['load'] + dd['export'], soc + cin * cfg['eff'], cfg['slotOut'])
                dl = min(load[i], q)
                dx = min(q - dl, cfg['exportSlot']) if allow_export else 0
            planned_soc = plan['plannedSoc'][n] + cfg['reserve']
        soc += cin * cfg['eff'] - dl - dx

        slots[i] = {'i': i, 'cin': cin, 'dl': dl, 'dx': dx, 'soc': soc,
                    'plannedSoc': planned_soc}

        # settle: forecaster learns the actual, day buffer fills
        sd = slot_of_day(usage['wall'][i])
        fc.settle(cal_key[i], sd, load[i])
        day_buf[sd] = load[i] if day_buf[sd] is None else (day_buf[sd] + load[i]) / 2
        day_done = i + 1 == T or cal_key[i + 1] != cal_key[i]
        if day_done:
            fc.complete_day(cal_key[i], day_buf)
            day_buf = [None] * 48

        if publishes:
            nxt = day_end.get(agile_key[min(day_end[agile_key[i]], T - 1)])
            if nxt is None:
                nxt = T
            replan_at(min(i + 1, T - 1), max(nxt, day_end[agile_key[i]]))

    return slots, replans, FORECAST_DEFAULTS['warmupDays']


if __name__ == '__main__':
    # Self-check: run the three fixture cases and print totals.
    from gen_causal_fixtures import CASES, BASE, synth

    for name, extra in CASES:
        usage, load, imp, exp = synth(35, seed=42)
        params = {**BASE, **extra}
        slots, replans, warmup = run_replay(usage, load, imp, exp, make_cfg(params), params)
        cin = sum(s['cin'] for s in slots)
        dl = sum(s['dl'] for s in slots)
        dx = sum(s['dx'] for s in slots)
        print(f'{name:20s} slots={len(slots)} replans={replans} '
              f'cin={cin:.6f} dl={dl:.6f} dx={dx:.6f} '
              f'socMax={max(s["soc"] for s in slots):.6f} '
              f'socMin={min(s["soc"] for s in slots):.3e}')
