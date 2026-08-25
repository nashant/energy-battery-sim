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

// Trajectory helpers: L[t] = usable energy at END of slot t.
const minOver = (L, a, b) => { let m = Infinity; for (let t = a; t < b; t++) m = Math.min(m, L[t]); return m; };
const maxOver = (L, a, b) => { let m = -Infinity; for (let t = a; t < b; t++) m = Math.max(m, L[t]); return m; };
const addRange = (L, a, b, q) => { for (let t = a; t < b; t++) L[t] += q; };

export function solveHorizon(soc0, imp, exp, loadF, cfg, mode, allowExport) {
  const T = imp.length;
  const L = new Float64Array(T).fill(Math.min(soc0, cfg.cap));
  const chg = new Map();                      // t -> grid-side kWh
  const disRaw = new Map();                   // t -> pack-side kWh out (pre-netting)
  const slotRem = new Float64Array(T).fill(cfg.slotOut);

  const buckets = dischargeBuckets(imp, exp, loadF, 0, allowExport, cfg)
    .map((b) => ({ ...b }));                  // local copies; qty is mutated

  const commit = (b, q) => {
    disRaw.set(b.t, (disRaw.get(b.t) || 0) + q);
    addRange(L, b.t, T, -q);
    slotRem[b.t] -= q;
    b.qty -= q;
  };

  // Pass 1: spend the energy already in the pack on the best-value slots anywhere.
  // It only ever discharges, and it runs first, so the slots it commits are the ones
  // pass 2 must then refuse to charge (one-meter rule, enforced in pass 2 below).
  for (const b of buckets) {
    if (b.val <= MARGIN) break;               // worthless: hold instead (beyond-horizon rule)
    const q = Math.min(b.qty, slotRem[b.t], minOver(L, b.t, T));
    if (q > EPS) commit(b, q);
  }

  // Pass 2: matched charge->discharge pairs, best spread first, trajectory-feasible.
  if (mode === 'contiguous') {
    contiguousPass(L, chg, disRaw, slotRem, imp, exp, loadF, cfg, allowExport);
  } else {
    const cand = [];
    for (let t = 0; t < T; t++) {
      if (imp[t] <= cfg.maxChgP) {
        cand.push({ t, cost: imp[t] / cfg.eff, room: chargeInSlot(cfg, loadF[t]) });
      }
    }
    cand.sort((a, b) => a.cost - b.cost || a.t - b.t);
    for (const b of buckets) {
      if (b.qty <= EPS || b.val <= MARGIN) continue;
      // One-meter rule: a slot is either importing or exporting, never both. Both maps
      // grow as pairs commit, so the tests are made here, at pair-commit time.
      if ((chg.get(b.t) || 0) > EPS) continue;          // this slot already charges
      for (const c of cand) {
        if (b.qty <= EPS) break;
        if (b.val <= c.cost + MARGIN) break;  // cand sorted: nothing cheaper left
        if (c.room <= EPS || c.t >= b.t) continue;
        if ((disRaw.get(c.t) || 0) > EPS) continue;      // this slot already discharges
        const head = cfg.cap - maxOver(L, c.t, b.t);
        const q = Math.min(b.qty, slotRem[b.t], c.room * cfg.eff, head);
        if (q <= EPS) continue;
        chg.set(c.t, (chg.get(c.t) || 0) + q / cfg.eff);
        c.room -= q / cfg.eff;
        addRange(L, c.t, T, q);           // commit()'s -q spans [b.t, T); this must match to T too
        commit(b, q);
      }
    }
  }

  // Netting: within each slot, output covers forecast load before export (one-meter rule).
  const discharge = new Map();
  for (const [t, tot] of disRaw) {
    const load = Math.min(loadF[t], tot);
    discharge.set(t, { load, export: allowExport ? tot - load : 0 });
  }
  const ts = [...chg.keys()];
  return { chg, discharge, plannedSoc: L,
           window: ts.length ? [Math.min(...ts), Math.max(...ts)] : null };
}

// Contiguous mode: one unbroken charge window per plan, discharge strictly after it —
// the same shape solveDay's contiguous branch had, made soc0/trajectory-aware.
function contiguousPass(L, chg, disRaw, slotRem, imp, exp, loadF, cfg, allowExport) {
  const T = imp.length;
  // Remaining discharge opportunity from slot s: load already served in pass 1
  // must not be counted again (load-first netting), and per-slot output caps hold.
  const build = (s) => dischargeBuckets(imp, exp, loadF, s, allowExport, cfg)
    .map((b) => {
      const committed = disRaw.get(b.t) || 0;
      const base = b.kind === 'load'
        ? Math.max(0, Math.min(loadF[b.t], cfg.slotOut) - committed)
        : b.qty;
      return { ...b, qty: Math.min(base, slotRem[b.t]) };
    })
    .filter((b) => b.qty > EPS);
  // Memo, valid for the whole call: build() reads only imp/exp/loadF/cfg/disRaw/slotRem,
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
        // One-meter rule: a slot pass 1 already discharges cannot also import.
        const add = (disRaw.get(t) || 0) > EPS
          ? 0 : Math.min(chargeInSlot(cfg, loadF[t]) * cfg.eff, rem);
        if (add <= EPS) continue;
        cost += (add / cfg.eff) * imp[t];
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
