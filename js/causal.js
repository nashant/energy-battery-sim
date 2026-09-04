// Causal engine: forecaster + receding-horizon planner. The planner may only see
// current SOC, published prices, and forecast load — the causality guard test
// (test/causal.mjs) mutates the future and asserts decisions don't change.

import { chargeInSlot, dischargeBuckets, cumAll, valueFor, takeDischarge } from './optimiser.js';

const EPS = 1e-12, MARGIN = 1e-9;

export const FORECAST_DEFAULTS = { alpha: 0.15, lambdaFull: 0.75, rampSlots: 16, warmupDays: 14 };

export class Forecaster {
  constructor(opts = {}) {
    const o = { ...FORECAST_DEFAULTS, ...opts };
    this.alpha = o.alpha; this.lambdaFull = o.lambdaFull; this.rampSlots = o.rampSlots;
    this.profiles = { wd: null, we: null };
    this.daysSeen = { wd: 0, we: 0 };
    this.todayActual = 0; this.todayExpected = 0; this.slotsElapsed = 0;
  }
  static dayType(dateStr) {
    const d = new Date(dateStr + 'T12:00:00Z').getUTCDay();
    return (d === 0 || d === 6) ? 'we' : 'wd';
  }
  base(type, s) {
    const p = this.profiles[type] ?? this.profiles[type === 'wd' ? 'we' : 'wd'];
    return p ? (p[s] ?? 0) : 0;
  }
  ratio() {
    if (this.slotsElapsed === 0 || this.todayExpected <= 1e-9) return 1;
    const r = this.todayActual / this.todayExpected;
    const lam = this.lambdaFull * Math.min(1, this.slotsElapsed / this.rampSlots);
    return 1 + lam * (r - 1);
  }
  forecast(entries, todayDate) {
    const r = this.ratio();
    return entries.map(({ date, slotOfDay }) => {
      const b = this.base(Forecaster.dayType(date), slotOfDay);
      return date === todayDate ? b * r : b;   // regime ratio never crosses midnight
    });
  }
  settle(date, slotOfDay, actualKwh) {
    this.todayExpected += this.base(Forecaster.dayType(date), slotOfDay);
    this.todayActual += actualKwh;
    this.slotsElapsed++;
  }
  completeDay(date, actualBySlot) {
    const type = Forecaster.dayType(date);
    if (!this.profiles[type]) {
      this.profiles[type] = actualBySlot.map((v) => v ?? 0);
    } else {
      this.profiles[type] = this.profiles[type].map((v, s) => {
        const a = actualBySlot[s];
        return a === null || a === undefined ? v : this.alpha * a + (1 - this.alpha) * v;
      });
    }
    this.daysSeen[type]++;
    this.todayActual = 0; this.todayExpected = 0; this.slotsElapsed = 0;
  }
}

// PV forecaster. The plan may only read a forecast that existed at plan time: the day-1
// value for slot t was issued 24 h before t, so it is usable only when t - 48 <= now;
// otherwise the day-2 value stands in. Actual PV is learned per slot into an intra-day
// ratio (today's actual / today's forecast over daylight slots), damped like the load ratio.
export class PvForecaster {
  constructor(pv, opts = FORECAST_DEFAULTS) {
    this.pv = pv; this.lambdaFull = opts.lambdaFull; this.rampSlots = 8;
    this.todayActual = 0; this.todayExpected = 0; this.daylight = 0;
  }
  static pick(a, b, t) {
    const x = a[t], y = b[t];
    return Number.isFinite(x) ? x : (Number.isFinite(y) ? y : 0);
  }
  base(t, now) {
    const p = this.pv;
    return t - 48 <= now
      ? { ac: PvForecaster.pick(p.acF1, p.acF2, t), dc: PvForecaster.pick(p.dcF1, p.dcF2, t) }
      : { ac: PvForecaster.pick(p.acF2, p.acF1, t), dc: PvForecaster.pick(p.dcF2, p.dcF1, t) };
  }
  ratio() {
    if (this.daylight === 0 || this.todayExpected <= 1e-9) return 1;
    const lam = this.lambdaFull * Math.min(1, this.daylight / this.rampSlots);
    return 1 + lam * (this.todayActual / this.todayExpected - 1);
  }
  forecast(i, h, calKey) {
    const r = this.ratio(), today = calKey[i];
    const ac = new Float64Array(h - i), dc = new Float64Array(h - i);
    for (let t = i; t < h; t++) {
      const b = this.base(t, i), m = calKey[t] === today ? r : 1;
      ac[t - i] = b.ac * m; dc[t - i] = b.dc * m;
    }
    return { ac, dc };
  }
  settle(t) {
    const b = this.base(t, t), f = b.ac + b.dc, a = this.pv.ac[t] + this.pv.dc[t];
    if (f > 1e-9 || a > 1e-9) { this.todayExpected += f; this.todayActual += a; this.daylight++; }
  }
  completeDay() { this.todayActual = 0; this.todayExpected = 0; this.daylight = 0; }
}

// Trajectory helpers: L[t] = usable energy at END of slot t.
const minOver = (L, a, b) => { let m = Infinity; for (let t = a; t < b; t++) m = Math.min(m, L[t]); return m; };
const maxOver = (L, a, b) => { let m = -Infinity; for (let t = a; t < b; t++) m = Math.max(m, L[t]); return m; };
const addRange = (L, a, b, q) => { for (let t = a; t < b; t++) L[t] += q; };

export function solveHorizon(soc0, imp, exp, loadF, cfg, mode, allowExport, pvF = null) {
  const T = imp.length;
  const L = new Float64Array(T).fill(Math.min(soc0, cfg.cap));
  const chg = new Map();                      // t -> grid-side kWh
  const pvChg = new Map();                    // t -> PV kWh (AC/DC side) into the pack
  const disRaw = new Map();                   // t -> pack-side kWh out (pre-netting)
  const slotRem = new Float64Array(T).fill(cfg.slotOut);

  // Net load: PV serves the house first. A deficit slot behaves exactly as load did; a
  // surplus slot exports (or spills) what the pack does not take, so it never imports.
  const defF = new Float64Array(T), surF = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    const pv = pvF ? pvF.ac[t] + pvF.dc[t] : 0;
    const net = loadF[t] - pv;
    defF[t] = Math.max(0, net); surF[t] = Math.max(0, -net);
  }

  const buckets = dischargeBuckets(imp, exp, defF, 0, allowExport, cfg)
    .map((b) => ({ ...b }));                  // local copies; qty is mutated

  const commit = (b, q) => {
    disRaw.set(b.t, (disRaw.get(b.t) || 0) + q);
    addRange(L, b.t, T, -q);
    slotRem[b.t] -= q;
    b.qty -= q;
  };

  // Pack-side cost of refilling at slot t: grid import (deficit slots) or the export
  // revenue PV surplus would otherwise earn (surplus slots); Infinity where neither applies.
  const refill = new Float64Array(T);
  for (let t = 0; t < T; t++) {
    if (surF[t] > EPS) refill[t] = (allowExport ? Math.max(0, exp[t]) : 0) / cfg.eff + cfg.wearP;
    else refill[t] = imp[t] <= cfg.maxChgP ? Math.max(0, imp[t]) / cfg.eff + cfg.wearP : Infinity;
  }

  // Pass 1: spend the energy already in the pack on the best-value slots anywhere.
  // It only ever discharges, and it runs first, so the slots it commits are the ones
  // pass 2 must then refuse to charge (one-meter rule, enforced in pass 2 below).
  // Energy is worth at least what refilling it would cost, pack-side, so anything valued
  // below that is held, not spent. cfg.holdFor picks the refill that sets the floor:
  // the cheapest chargeable slot anywhere in the horizon, or only one AFTER the slot
  // being valued (energy spent before the refill cannot be replaced by it), or none.
  // cfg.packEnergyWorth 'refillCost' values a LOAD bucket at no more than the cheapest
  // charge cost before it: load a refill can serve is left to pass 2, so existing energy
  // goes to export and to load before the refill instead of to tomorrow's load.
  let floor1 = Infinity;
  for (let t = 0; t < T; t++) floor1 = Math.min(floor1, refill[t]);
  if (!Number.isFinite(floor1)) floor1 = 0;
  const sufMin = new Float64Array(T), preMin = new Float64Array(T);
  for (let t = T - 1, m = Infinity; t >= 0; t--) { sufMin[t] = m; m = Math.min(m, refill[t]); }
  for (let t = 0, m = Infinity; t < T; t++) { preMin[t] = m; m = Math.min(m, refill[t]); }
  const packCost = (c) => (Number.isFinite(c) ? c : 0);
  const floorAt = (t) => cfg.holdFor === 'never' ? 0
    : cfg.holdFor === 'laterCheaperRefill' ? packCost(sufMin[t]) : floor1;
  const refillCost = cfg.packEnergyWorth === 'refillCost';
  const worth = (b) => refillCost && b.kind === 'load' && Number.isFinite(preMin[b.t])
    ? Math.min(b.val, preMin[b.t]) : b.val;
  const order1 = refillCost ? [...buckets].sort((a, b) => worth(b) - worth(a)) : buckets;
  for (const b of order1) {
    if (worth(b) <= floorAt(b.t) + MARGIN) continue;   // worth less than a refill: hold
    const q = Math.min(b.qty, slotRem[b.t], minOver(L, b.t, T));
    if (q > EPS) commit(b, q);
  }

  // Pass 2a: PV surplus into the pack, best spread first, in every mode — free-ish energy
  // must never be displaced by a paid grid window.
  const pvCand = [];
  for (let t = 0; t < T; t++) {
    if (surF[t] > EPS) pvCand.push({ t, cost: refill[t], room: Math.min(surF[t], cfg.slotIn), into: pvChg });
  }
  pairPass(pvCand, buckets, chg, pvChg, disRaw, slotRem, L, cfg, T);

  // Pass 2b: matched grid-charge -> discharge pairs.
  if (mode === 'contiguous') {
    contiguousPass(L, chg, pvChg, disRaw, slotRem, imp, exp, defF, surF, cfg, allowExport);
  } else {
    const cand = [];
    for (let t = 0; t < T; t++) {
      if (surF[t] <= EPS && imp[t] <= cfg.maxChgP) {
        // unclamped: a negative import price is a real negative cost to pair against
        cand.push({ t, cost: imp[t] / cfg.eff + cfg.wearP, room: chargeInSlot(cfg, defF[t]), into: chg });
      }
    }
    pairPass(cand, buckets, chg, pvChg, disRaw, slotRem, L, cfg, T);
  }

  // Netting: within each slot, output covers the forecast deficit before export.
  const discharge = new Map();
  for (const [t, tot] of disRaw) {
    const load = Math.min(defF[t], tot);
    discharge.set(t, { load, export: allowExport ? tot - load : 0 });
  }
  const ts = [...chg.keys()];
  return { chg, pvChg, discharge, plannedSoc: L,
           window: ts.length ? [Math.min(...ts), Math.max(...ts)] : null };
}

// Pair charge candidates (grid or PV, pre-sorted by cost) with discharge buckets, best
// value first, trajectory-feasible. One-meter rule: a slot already charging (grid or PV)
// takes no discharge, and a slot already discharging takes no charge.
function pairPass(cand, buckets, chg, pvChg, disRaw, slotRem, L, cfg, T) {
  cand.sort((a, b) => a.cost - b.cost || a.t - b.t);
  const commit = (b, q) => {
    disRaw.set(b.t, (disRaw.get(b.t) || 0) + q);
    addRange(L, b.t, T, -q);
    slotRem[b.t] -= q;
    b.qty -= q;
  };
  for (const b of buckets) {
    if (b.qty <= EPS || b.val <= MARGIN) continue;
    if ((chg.get(b.t) || 0) > EPS || (pvChg.get(b.t) || 0) > EPS) continue;
    for (const c of cand) {
      if (b.qty <= EPS) break;
      if (b.val <= c.cost + MARGIN) break;  // cand sorted: nothing cheaper left
      if (c.room <= EPS || c.t >= b.t) continue;
      if ((disRaw.get(c.t) || 0) > EPS) continue;
      const head = cfg.cap - maxOver(L, c.t, b.t);
      const q = Math.min(b.qty, slotRem[b.t], c.room * cfg.eff, head);
      if (q <= EPS) continue;
      c.into.set(c.t, (c.into.get(c.t) || 0) + q / cfg.eff);
      c.room -= q / cfg.eff;
      addRange(L, c.t, T, q);           // commit()'s -q spans [b.t, T); this must match to T too
      commit(b, q);
    }
  }
}

// Contiguous mode: one charge window per plan (pass-1 discharge slots inside it are
// skipped, so the fill can have holes), discharge strictly after it —
// the same shape solveDay's contiguous branch had, made soc0/trajectory-aware.
function contiguousPass(L, chg, pvChg, disRaw, slotRem, imp, exp, loadF, surF, cfg, allowExport) {
  const T = imp.length;
  // Remaining discharge opportunity from slot s: load already served in pass 1
  // must not be counted again (load-first netting), and per-slot output caps hold.
  // One-meter rule: a slot pass 2a already PV-charges cannot also discharge.
  const build = (s) => dischargeBuckets(imp, exp, loadF, s, allowExport, cfg)
    .map((b) => {
      const committed = disRaw.get(b.t) || 0;
      const base = b.kind === 'load'
        ? Math.max(0, Math.min(loadF[b.t], cfg.slotOut) - committed)
        : b.qty;
      return { ...b, qty: Math.min(base, slotRem[b.t]) };
    })
    .filter((b) => b.qty > EPS && (pvChg.get(b.t) || 0) <= EPS);
  // Memo, valid for the whole call: build() reads only imp/exp/loadF/cfg/disRaw/slotRem/pvChg,
  // and none of those are mutated between here and the window search's end. Without it
  // the search rebuilt (and re-cumulated) the same O(T) bucket list inside an O(T²)
  // double loop — O(T³ log T) for a 62-slot horizon, ~4.9s over a replayed year.
  const memo = new Map();
  const bucketsFrom = (s) => {
    let m = memo.get(s);
    if (!m) { const bk = build(s); m = { bk, cum: cumAll(bk) }; memo.set(s, m); }
    return m;
  };
  let best = null;
  for (let i = 0; i < T; i++) {
    for (let len = 1; len <= T - i; len++) {
      if (imp[i + len - 1] > cfg.maxChgP) break;
      const head = cfg.cap - maxOver(L, i, i + len);
      if (head <= EPS) continue;
      const { bk, cum } = bucketsFrom(i + len);
      const absorbable = bk.reduce((a, b) => a + b.qty, 0);
      // fill only what the remaining horizon can absorb — the energy-balance rule
      const target = Math.min(head, absorbable);
      if (target <= MARGIN) continue;
      let rem = target, cost = 0;
      const w = new Map();
      for (let t = i; t < i + len; t++) {
        // One-meter rule: a slot that discharges, PV-charges, or exports surplus cannot import.
        const add = (disRaw.get(t) || 0) > EPS || (pvChg.get(t) || 0) > EPS || surF[t] > EPS
          ? 0 : Math.min(chargeInSlot(cfg, loadF[t]) * cfg.eff, rem);
        if (add <= EPS) continue;
        cost += (add / cfg.eff) * imp[t] + add * cfg.wearP;
        w.set(t, add / cfg.eff);
        rem -= add;
      }
      const E = target - rem;
      if (E <= MARGIN) continue;
      const gain = valueFor(cum, E);
      if (gain === null) continue;
      if (!best || gain - cost > best.profit + MARGIN) {
        best = { profit: gain - cost, w, E, s: i + len };
      }
    }
  }
  if (!best || best.profit <= MARGIN) return;
  for (const [t, q] of best.w) chg.set(t, (chg.get(t) || 0) + q);
  const packIn = best.E;
  const first = Math.min(...best.w.keys());
  addRange(L, first, T, packIn);              // must match takeDischarge's -q span [t, T) below
  const { alloc } = takeDischarge(bucketsFrom(best.s).bk, packIn);
  for (const [t, dd] of alloc) {
    const q = dd.load + dd.export;
    disRaw.set(t, (disRaw.get(t) || 0) + q);
    addRange(L, t, T, -q);                    // energy sits in [s, t) before being spent here
    slotRem[t] -= q;
  }
}
