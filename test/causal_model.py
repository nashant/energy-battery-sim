#!/usr/bin/env python3
"""Python reference for the causal engine — a line-for-line transcription of
js/optimiser.js (primitives), js/causal.js (Forecaster, PvForecaster, solveHorizon,
pairPass, contiguousPass) and runReplay from js/data.js.

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
  * `Number.isFinite(x)` on a maybe-missing array entry -> `x is not None and
                               math.isfinite(x)` (JS `undefined` -> Python `None`).
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
    cap = p['capacity'] * (1 - floor)
    cycle_life = p.get('cycleLife') or 0
    battery_cost = p.get('batteryCost') or 0
    wear_p = (battery_cost * 100) / (cycle_life * cap) if cycle_life > 0 and battery_cost > 0 and cap > 0 else 0
    return {
        'cap': cap,
        'wearP': wear_p,
        'reserve': p['capacity'] * floor,
        'eff': p['roundTrip'],
        'slotIn': inv_slot,
        'slotOut': inv_slot,
        'chgStep': inv_slot * p['roundTrip'],
        'importCap': p['totalImportLimitKw'] * 0.5 if p.get('totalImportLimitKw') else None,
        'maxChgP': INF if mcp is None or mcp == '' else float(mcp),
        # the battery's own per-slot export bound; exportCap is the connection's total
        # (G100), Infinity when no limit is entered
        'exportSlot': p['exportLimitKw'] * 0.5 if p.get('exportLimitKw') else inv_slot,
        'exportCap': p['exportLimitKw'] * 0.5 if p.get('exportLimitKw') else INF,
        # planner options (README "Planner options"); defaults are the shipped behaviour
        'holdFor': p.get('holdFor') or 'anyCheaperRefill',
        'packEnergyWorth': p.get('packEnergyWorth') or 'displacedPrice',
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


# PV forecaster. The plan may only read a forecast that existed at plan time: the day-1
# value for slot t was issued 24 h before t, so it is usable only when t - 48 <= now;
# otherwise the day-2 value stands in. Actual PV is learned per slot into an intra-day
# ratio (today's actual / today's forecast over daylight slots), damped like the load ratio.
class PvForecaster:
    def __init__(self, pv, opts=None):
        o = FORECAST_DEFAULTS if opts is None else opts
        self.pv = pv
        self.lambdaFull = o['lambdaFull']
        self.rampSlots = 8
        self.todayActual = 0
        self.todayExpected = 0
        self.daylight = 0

    @staticmethod
    def pick(a, b, t):
        # JS: Number.isFinite(x) ? x : (Number.isFinite(y) ? y : 0); a missing entry is
        # undefined in JS and None here, and NaN/Infinity fail isFinite in both.
        x, y = a[t], b[t]
        if x is not None and math.isfinite(x):
            return x
        if y is not None and math.isfinite(y):
            return y
        return 0

    def base(self, t, now):
        p = self.pv
        if t - 48 <= now:
            return {'ac': PvForecaster.pick(p['acF1'], p['acF2'], t),
                    'dc': PvForecaster.pick(p['dcF1'], p['dcF2'], t)}
        return {'ac': PvForecaster.pick(p['acF2'], p['acF1'], t),
                'dc': PvForecaster.pick(p['dcF2'], p['dcF1'], t)}

    def ratio(self):
        if self.daylight == 0 or self.todayExpected <= 1e-9:
            return 1
        lam = self.lambdaFull * min(1, self.daylight / self.rampSlots)
        return 1 + lam * (self.todayActual / self.todayExpected - 1)

    def forecast(self, i, h, cal_key):
        r = self.ratio()
        today = cal_key[i]
        ac = [0.0] * (h - i)
        dc = [0.0] * (h - i)
        for t in range(i, h):
            b = self.base(t, i)
            m = r if cal_key[t] == today else 1
            ac[t - i] = b['ac'] * m
            dc[t - i] = b['dc'] * m
        return {'ac': ac, 'dc': dc}

    def settle(self, t):
        b = self.base(t, t)
        f = b['ac'] + b['dc']
        a = self.pv['ac'][t] + self.pv['dc'][t]
        if f > 1e-9 or a > 1e-9:
            self.todayExpected += f
            self.todayActual += a
            self.daylight += 1

    def complete_day(self):
        self.todayActual = 0
        self.todayExpected = 0
        self.daylight = 0


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


def solve_horizon(soc0, imp, exp, load_f, cfg, mode, allow_export, pv_f=None):
    T = len(imp)
    L = [min(soc0, cfg['cap'])] * T
    chg = {}                                       # t -> grid-side kWh
    pv_chg = {}                                    # t -> PV kWh (AC/DC side) into the pack
    dis_raw = {}                                   # t -> pack-side kWh out (pre-netting)
    slot_rem = [cfg['slotOut']] * T

    # Net load: PV serves the house first. A deficit slot behaves exactly as load did; a
    # surplus slot exports (or spills) what the pack does not take, so it never imports.
    def_f = [0.0] * T
    sur_f = [0.0] * T
    for t in range(T):
        pv = (pv_f['ac'][t] + pv_f['dc'][t]) if pv_f is not None else 0
        net = load_f[t] - pv
        def_f[t] = max(0, net)
        sur_f[t] = max(0, -net)

    buckets = [dict(b) for b in
               discharge_buckets(imp, exp, def_f, 0, allow_export, cfg)]

    def commit(b, q):
        dis_raw[b['t']] = dis_raw.get(b['t'], 0) + q
        _add_range(L, b['t'], T, -q)
        slot_rem[b['t']] -= q
        b['qty'] -= q

    # Pack-side cost of refilling at slot t: grid import (deficit slots) or the export
    # revenue PV surplus would otherwise earn (surplus slots); Infinity where neither applies.
    refill = [INF] * T
    for t in range(T):
        if sur_f[t] > EPS:
            refill[t] = (max(0, exp[t]) if allow_export else 0) / cfg['eff'] + cfg['wearP']
        else:
            refill[t] = (max(0, imp[t]) / cfg['eff'] + cfg['wearP']
                         if imp[t] <= cfg['maxChgP'] else math.inf)

    # Pass 1: spend the energy already in the pack on the best-value slots anywhere.
    # It only ever discharges, and it runs first, so the slots it commits are the ones
    # pass 2 must then refuse to charge (one-meter rule, enforced in pass 2 below).
    # Energy is worth at least what refilling it would cost, pack-side, so anything
    # valued below that is held, not spent. cfg['holdFor'] picks the refill that sets the
    # floor (anywhere / after the slot / none); cfg['packEnergyWorth'] == 'refillCost'
    # caps a LOAD bucket at the cheapest charge cost before it, so load a refill can
    # serve is left to pass 2.
    floor1 = math.inf
    for t in range(T):
        floor1 = min(floor1, refill[t])
    if not math.isfinite(floor1):
        floor1 = 0
    suf_min = [math.inf] * T
    pre_min = [math.inf] * T
    m = math.inf
    for t in range(T - 1, -1, -1):
        suf_min[t] = m
        m = min(m, refill[t])
    m = math.inf
    for t in range(T):
        pre_min[t] = m
        m = min(m, refill[t])

    def pack_cost(c):
        return c if math.isfinite(c) else 0

    def floor_at(t):
        if cfg['holdFor'] == 'never':
            return 0
        if cfg['holdFor'] == 'laterCheaperRefill':
            return pack_cost(suf_min[t])
        return floor1

    refill_cost = cfg['packEnergyWorth'] == 'refillCost'

    def worth(b):
        if refill_cost and b['kind'] == 'load' and math.isfinite(pre_min[b['t']]):
            return min(b['val'], pre_min[b['t']])
        return b['val']

    order1 = sorted(buckets, key=lambda b: -worth(b)) if refill_cost else buckets
    for b in order1:
        if worth(b) <= floor_at(b['t']) + MARGIN:
            continue
        q = min(b['qty'], slot_rem[b['t']], _min_over(L, b['t'], T))
        if q > EPS:
            commit(b, q)

    # Pass 2a: PV surplus into the pack, best spread first, in every mode — free-ish
    # energy must never be displaced by a paid grid window.
    pv_cand = []
    for t in range(T):
        if sur_f[t] > EPS:
            pv_cand.append({'t': t, 'cost': refill[t],
                            'room': min(sur_f[t], cfg['slotIn']), 'into': pv_chg})
    _pair_pass(pv_cand, buckets, chg, pv_chg, dis_raw, slot_rem, L, cfg, T)

    # Pass 2b: matched grid-charge -> discharge pairs.
    if mode == 'contiguous':
        _contiguous_pass(L, chg, pv_chg, dis_raw, slot_rem, imp, exp, def_f, sur_f, cfg,
                         allow_export)
    else:
        cand = []
        for t in range(T):
            if sur_f[t] <= EPS and imp[t] <= cfg['maxChgP']:
                # unclamped: a negative import price is a real negative cost to pair against
                cand.append({'t': t, 'cost': imp[t] / cfg['eff'] + cfg['wearP'],
                             'room': charge_in_slot(cfg, def_f[t]), 'into': chg})
        _pair_pass(cand, buckets, chg, pv_chg, dis_raw, slot_rem, L, cfg, T)

    # Netting: within each slot, output covers the forecast deficit before export.
    discharge = {}
    for t, tot in dis_raw.items():
        load = min(def_f[t], tot)
        discharge[t] = {'load': load, 'export': tot - load if allow_export else 0}
    ts = list(chg.keys())
    return {'chg': chg, 'pvChg': pv_chg, 'discharge': discharge, 'plannedSoc': L,
            'window': [min(ts), max(ts)] if ts else None}


# Pair charge candidates (grid or PV, pre-sorted by cost) with discharge buckets, best
# value first, trajectory-feasible. One-meter rule: a slot already charging (grid or PV)
# takes no discharge, and a slot already discharging takes no charge.
def _pair_pass(cand, buckets, chg, pv_chg, dis_raw, slot_rem, L, cfg, T):
    cand.sort(key=lambda c: (c['cost'], c['t']))   # JS: a.cost - b.cost || a.t - b.t

    def commit(b, q):
        dis_raw[b['t']] = dis_raw.get(b['t'], 0) + q
        _add_range(L, b['t'], T, -q)
        slot_rem[b['t']] -= q
        b['qty'] -= q

    for b in buckets:
        if b['qty'] <= EPS or b['val'] <= MARGIN:
            continue
        # One-meter rule: a slot is either importing or exporting, never both. Both
        # dicts grow as pairs commit, so the tests are made here, at pair-commit time.
        if chg.get(b['t'], 0) > EPS or pv_chg.get(b['t'], 0) > EPS:
            continue                               # this slot already charges
        for c in cand:
            if b['qty'] <= EPS:
                break
            if b['val'] <= c['cost'] + MARGIN:
                break                              # cand sorted: nothing cheaper left
            if c['room'] <= EPS or c['t'] >= b['t']:
                continue
            if dis_raw.get(c['t'], 0) > EPS:
                continue                           # this slot already discharges
            head = cfg['cap'] - _max_over(L, c['t'], b['t'])
            q = min(b['qty'], slot_rem[b['t']], c['room'] * cfg['eff'], head)
            if q <= EPS:
                continue
            c['into'][c['t']] = c['into'].get(c['t'], 0) + q / cfg['eff']
            c['room'] -= q / cfg['eff']
            _add_range(L, c['t'], T, q)
            commit(b, q)


def _contiguous_pass(L, chg, pv_chg, dis_raw, slot_rem, imp, exp, load_f, sur_f, cfg,
                     allow_export):
    T = len(imp)

    # One-meter rule: a slot pass 2a already PV-charges cannot also discharge.
    def build(s):
        out = []
        for b in discharge_buckets(imp, exp, load_f, s, allow_export, cfg):
            committed = dis_raw.get(b['t'], 0)
            base = (max(0, min(load_f[b['t']], cfg['slotOut']) - committed)
                    if b['kind'] == 'load' else b['qty'])
            nb = dict(b)
            nb['qty'] = min(base, slot_rem[b['t']])
            out.append(nb)
        return [b for b in out if b['qty'] > EPS and pv_chg.get(b['t'], 0) <= EPS]

    # Memo, valid for the whole call: build() reads only imp/exp/load_f/cfg/dis_raw/
    # slot_rem/pv_chg, and none of those are mutated between here and the search's end.
    # Without it the search rebuilt (and re-cumulated) the same O(T) bucket list inside
    # an O(T^2) double loop.
    memo = {}

    def buckets_from(s):
        if s not in memo:
            bk = build(s)
            memo[s] = (bk, cum_all(bk))
        return memo[s]

    best = None
    for i in range(T):
        for length in range(1, T - i + 1):
            if imp[i + length - 1] > cfg['maxChgP']:
                break
            head = cfg['cap'] - _max_over(L, i, i + length)
            if head <= EPS:
                continue
            bk, cum = buckets_from(i + length)
            absorbable = 0
            for b in bk:
                absorbable = absorbable + b['qty']
            target = min(head, absorbable)
            if target <= MARGIN:
                continue
            rem, cost = target, 0
            w = {}
            for t in range(i, i + length):
                # One-meter rule: a slot that discharges, PV-charges, or exports
                # surplus cannot import.
                add = (0 if (dis_raw.get(t, 0) > EPS or pv_chg.get(t, 0) > EPS
                             or sur_f[t] > EPS)
                       else min(charge_in_slot(cfg, load_f[t]) * cfg['eff'], rem))
                if add <= EPS:
                    continue
                cost += (add / cfg['eff']) * imp[t] + add * cfg['wearP']
                w[t] = add / cfg['eff']
                rem -= add
            E = target - rem
            if E <= MARGIN:
                continue
            gain = value_for(cum, E)
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
    alloc = take_discharge(buckets_from(best['s'])[0], pack_in)['alloc']
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


def run_replay(usage, load, imp, exp, cfg, params, pv=None):
    T = len(load)
    mode = params.get('cycle') or 'contiguous'
    allow_export = bool(params.get('allowExport'))
    agile_key = day_keys(usage, 'agile')               # tariff-day (23:00-23:00)
    cal_key = [w[0:10] for w in usage['wall']]
    day_end = {}
    for i in range(T):
        day_end[agile_key[i]] = i + 1

    fc = Forecaster()
    fc_pv = PvForecaster(pv) if pv is not None else None

    def pv_at(i, k):                                   # k: 'ac' | 'dc'
        return pv[k][i] if pv is not None else 0

    slots = [None] * T
    soc = 0
    replans = 0
    plan = None
    plan_start = 0
    plan_max_chg_p = 0
    horizon = day_end[agile_key[0]]
    day_buf = [None] * 48
    # priceHorizon 'knownSchedule48h': import schedule known ahead, plan 48 h out; export
    # beyond the published boundary is yesterday's same slot.
    known = params.get('priceHorizon') == 'knownSchedule48h'
    pub_end = horizon
    every = max(1, int(params.get('replanEvery') or 1))

    def extend(h, i):
        return min(T, max(h, i + 96)) if known else h

    def replan_at(i, h):
        nonlocal plan, plan_start, horizon, replans, plan_max_chg_p
        entries = [{'date': cal_key[t], 'slotOfDay': slot_of_day(usage['wall'][t])}
                   for t in range(i, h)]
        load_f = fc.forecast(entries, cal_key[i])
        if known:
            exp_s = []
            for k in range(h - i):
                t = i + k
                while t >= pub_end:
                    t -= 48
                exp_s.append(exp[t])
        else:
            exp_s = exp[i:h]
        pv_f = fc_pv.forecast(i, h, cal_key) if fc_pv is not None else None
        plan = solve_horizon(soc, imp[i:h], exp_s, load_f, cfg, mode, allow_export, pv_f)
        plan_start = i
        horizon = h
        replans += 1
        # marginal refill price: the dearest slot the plan charges in. A plan that books
        # no charging (pack already full for its horizon) keeps the last booked price, so
        # load-following never treats the pack's energy as free.
        m = 0
        for t in plan['chg'].keys():
            m = max(m, imp[i + t])
        if m > 0:
            plan_max_chg_p = m

    if params.get('useBattery') is not False:
        replan_at(0, extend(horizon, 0))

    for i in range(T):
        # publication: first slot of each calendar day at/after 16:00 extends the horizon
        # to the end of the NEXT tariff-day from the NEXT slot's plan onward.
        publishes = (params.get('useBattery') is not False
                     and usage['wall'][i][11:16] >= PUBLISH_HHMM
                     and (i == 0 or usage['wall'][i - 1][11:16] < PUBLISH_HHMM
                          or cal_key[i - 1] != cal_key[i]))

        # execute the active plan against ACTUAL load and ACTUAL PV
        p_a, p_d = pv_at(i, 'ac'), pv_at(i, 'dc')
        cin, pvc_dc, pvc_ac, dl, dx, planned_soc, pv_fc = 0, 0, 0, 0, 0, None, 0
        room = max(0, (cfg['cap'] - soc) / cfg['eff'])   # AC/DC-side kWh the pack can take
        if plan is not None and i >= plan_start and i < horizon:
            n = i - plan_start
            # 1. PV into the pack: DC first (no inverter pass), then AC through the charge
            # path. Bounded by the ACTUAL surplus as well as the plan's: when load beats
            # the forecast the house gets the PV, or the slot would import to store
            # energy priced at export.
            pvc_plan = min(plan['pvChg'].get(n, 0), max(0, p_a + p_d - load[i]))
            pvc_dc = min(pvc_plan, p_d, cfg['slotIn'], room)
            pvc_ac = min(pvc_plan - pvc_dc, p_a, cfg['slotIn'] - pvc_dc, room - pvc_dc)
            planned_soc = plan['plannedSoc'][n] + cfg['reserve']
            b = fc_pv.base(i, plan_start) if fc_pv is not None else None
            pv_fc = b['ac'] + b['dc'] if b is not None else 0
        pvc = pvc_dc + pvc_ac
        room -= pvc
        # 2. what PV is left serves the house; the DC remainder crosses the inverter later
        dc_rest = p_d - pvc_dc
        ac_rest = p_a - pvc_ac
        gross = ac_rest + dc_rest
        deficit = max(0, load[i] - gross)
        sur = max(0, gross - load[i])
        if plan is not None and i >= plan_start and i < horizon:
            n = i - plan_start
            # 3. grid charge only when nothing is being exported (one-meter rule)
            if sur <= 1e-12:
                cin = min(plan['chg'].get(n, 0), charge_in_slot(cfg, deficit), room)
            # 4. discharge: actual deficit first, then what the plan booked as export.
            dd = plan['discharge'].get(n)
            if dd is not None:
                q = min(dd['load'] + dd['export'], soc + (cin + pvc) * cfg['eff'],
                        cfg['slotOut'])
                dl = min(deficit, q)
                dx = min(q - dl, dd['export'], cfg['exportSlot']) if allow_export else 0
        # 5. self-use load-following on the remaining deficit (never while charging):
        # between planned actions the inverter covers what PV did not, but only when the
        # avoided import price beats the plan's marginal refill cost (dearest planned
        # charge, pack-side). An empty pack makes this a no-op.
        lf_floor = plan_max_chg_p / cfg['eff'] + cfg['wearP']
        if cin <= 1e-12 and pvc <= 1e-12 and imp[i] > lf_floor + 1e-9:
            extra = min(deficit - dl, soc - dl - dx, cfg['slotOut'] - dl - dx)
            if extra > 1e-12:
                dl += extra
        # 6. DC coupling: PV that is not charging shares the inverter's AC output with
        # discharge. The overflow comes off battery export FIRST — holding a kWh in the
        # pack is worth >= 0 later, while clipped PV is gone for good — and only what is
        # left clips the PV.
        over = max(0, dc_rest + dl + dx - cfg['slotOut'])
        trim = min(dx, over)
        dx -= trim
        over -= trim
        dc_clip = over
        dc_rest -= dc_clip
        gross = ac_rest + dc_rest
        deficit = max(0, load[i] - gross)
        sur = max(0, gross - load[i])                  # dl <= old def <= new def
        # the clip re-exposes deficit PV was covering. Serve it from the pack's booked
        # export instead of importing and exporting in the same half-hour: the pack-side
        # total is unchanged, so the inverter cap and the SOC trajectory still hold.
        shift = min(deficit - dl, dx)
        if shift > 1e-12:
            dl += shift
            dx -= shift
        # 7. PV surplus takes the connection's export capacity first: free PV that would
        # otherwise be spilled beats stored energy, which keeps its value in the pack.
        # What the battery does not export simply is not removed from soc.
        pvx = min(sur, cfg['exportCap']) if allow_export else 0
        dx = min(dx, max(0, cfg['exportCap'] - pvx))
        spill = sur - pvx + dc_clip
        soc += (cin + pvc) * cfg['eff'] - dl - dx

        slots[i] = {'i': i, 'cin': cin, 'pvc': pvc, 'dl': dl, 'dx': dx, 'pvx': pvx,
                    'spill': spill, 'soc': soc, 'plannedSoc': planned_soc,
                    'pvFc': pv_fc, 'def': deficit, 'pvHouse': min(load[i], gross)}

        # settle: forecaster learns the actual, day buffer fills
        sd = slot_of_day(usage['wall'][i])
        fc.settle(cal_key[i], sd, load[i])
        if fc_pv is not None:
            fc_pv.settle(i)
        day_buf[sd] = load[i] if day_buf[sd] is None else (day_buf[sd] + load[i]) / 2
        day_done = i + 1 == T or cal_key[i + 1] != cal_key[i]
        if day_done:
            fc.complete_day(cal_key[i], day_buf)
            day_buf = [None] * 48
            if fc_pv is not None:
                fc_pv.complete_day()

        # Receding horizon: re-plan at the start of every slot from the current SOC and
        # the forecast as it now stands. Publication extends the horizon to the end of the
        # NEXT tariff-day; otherwise the standing horizon (prices already published) is kept.
        if params.get('useBattery') is not False and i + 1 < T:
            h = horizon
            if publishes:
                nxt = day_end.get(agile_key[min(day_end[agile_key[i]], T - 1)])
                if nxt is None:
                    nxt = T
                h = max(nxt, day_end[agile_key[i]])
                pub_end = max(pub_end, h)
            if publishes or i + 1 >= horizon or (i + 1 - plan_start) % every == 0:
                replan_at(i + 1, extend(h, i + 1))

    return slots, replans, FORECAST_DEFAULTS['warmupDays']


if __name__ == '__main__':
    # Self-check: run the three fixture cases and print totals.
    from gen_causal_fixtures import CASES, BASE, synth

    for name, extra, exp_mul in CASES:
        usage, load, imp, exp = synth(35, seed=42)
        exp = [round(v * exp_mul, 4) for v in exp]
        params = {**BASE, **extra}
        slots, replans, warmup = run_replay(usage, load, imp, exp, make_cfg(params), params)
        cin = sum(s['cin'] for s in slots)
        dl = sum(s['dl'] for s in slots)
        dx = sum(s['dx'] for s in slots)
        print(f'{name:20s} slots={len(slots)} replans={replans} '
              f'cin={cin:.6f} dl={dl:.6f} dx={dx:.6f} '
              f'socMax={max(s["soc"] for s in slots):.6f} '
              f'socMin={min(s["soc"] for s in slots):.3e}')
