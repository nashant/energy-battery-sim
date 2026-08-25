# Causal Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the perfect-foresight batch solver with a causal receding-horizon engine: Run replays the whole CSV as accelerated real time, cold-starting from zero forecast.

**Architecture:** A stateful `Forecaster` (EWMA per-slot profile + intra-day ratio) and a pure `solveHorizon` planner (initial-SOC-aware, horizon-truncated) live in new `js/causal.js`, reusing `optimiser.js`'s bucket machinery. `runSim` in `data.js` becomes the replay loop (publication at 16:00 sim-time, re-plan from next slot, execution against actual load). A Python mirror (`test/causal_model.py`) is the reference; fixtures assert exact JS≡Python parity plus a mechanical no-future-leakage guard.

**Tech Stack:** Vanilla ES modules (no deps), Python 3 stdlib only, existing test pattern (`node test/*.mjs`, `python3 test/*.py`).

**Spec:** `docs/specs/2026-08-25-causal-engine-design.md`

## Global Constraints

- No new dependencies, JS or Python. ES modules; Python 3 stdlib.
- JS ≡ Python parity tolerance: `1e-9` per slot value.
- `runSim({ usage, load, imp, exp, scTotalP, params })` keeps its signature and return shape, except: `carried` removed; `warmupDays`, `replans` added; each `slots[]` entry gains `plannedSoc` (number|null).
- `params.boundary` is removed everywhere. `params.cycle` (`'contiguous'`|`'scattered'`) survives — it is a charge-shape choice, not a window choice.
- Planner may only read: current SOC, prices within the published horizon, forecast load. The causality guard test (Task 5) enforces this mechanically.
- Publication constant: `PUBLISH_HHMM = '16:00'` (simulated); plan takes effect from the slot after the publication slot (the "next boundary ≥ now+5m" rule at slot granularity).
- Forecast defaults: `alpha = 0.15`, `lambdaFull = 0.75`, `rampSlots = 16`, `warmupDays = 14`, intra-day ratio never crosses the day boundary. Deviation-trigger re-plan is NOT implemented (spec: default off; build only if replay evidence later justifies it — YAGNI now).
- Git: use `g` (alias for git). Commit at the end of every task. Run `node test/units.mjs && node test/dom.mjs; node test/causal.mjs` (once they exist) before each commit; suites that need the missing `~/Downloads/octopus-usage.csv` are excused.
- The root CLI `agile_battery_sim.py` is historical and untouched by this plan.

---

### Task 1: Forecaster (JS)

**Files:**
- Create: `js/causal.js`
- Modify: `test/units.mjs` (append tests BEFORE the final `process.exit(fail ? 1 : 0);` line — tests after it never run)

**Interfaces:**
- Produces: `class Forecaster` with:
  - `constructor(opts = {})` — opts override `FORECAST_DEFAULTS = { alpha: 0.15, lambdaFull: 0.75, rampSlots: 16, warmupDays: 14 }`
  - `static dayType(dateStr) -> 'wd'|'we'` (dateStr `'YYYY-MM-DD'`)
  - `base(type, slotOfDay) -> kWh` (cold start 0; falls back to the other day-type's profile if own is unseeded)
  - `ratio() -> number` (dampened intra-day ratio, 1 when no data)
  - `forecast(entries, todayDate) -> number[]` where entries = `[{date, slotOfDay}]`
  - `settle(date, slotOfDay, actualKwh)` — call after each slot executes
  - `completeDay(date, actualBySlot)` — `actualBySlot` is `Array(48)`, entries may be `null` (DST-missing slots keep old profile value); seeds profile on first day of that type, EWMA thereafter; resets intra-day state
  - `daysSeen` = `{ wd, we }` counters
- Consumes: nothing.

- [ ] **Step 1: Write the failing tests** — append to `test/units.mjs` before the `process.exit` line:

```js
import { Forecaster, FORECAST_DEFAULTS } from '../js/causal.js';

// cold start: zero forecast everywhere, ratio 1
{
  const f = new Forecaster();
  ok('forecaster cold start is zero', f.base('wd', 17) === 0);
  ok('forecaster cold ratio is 1', f.ratio() === 1);
  ok('forecaster cold forecast zeros',
     f.forecast([{ date: '2025-08-04', slotOfDay: 10 }], '2025-08-04')[0] === 0);
}
// seeding: first completed day IS the profile; EWMA thereafter
{
  const f = new Forecaster();
  const day = new Array(48).fill(0.5);
  f.completeDay('2025-08-04', day);                       // Monday -> wd seed
  ok('forecaster seeds first wd day', close(f.base('wd', 3), 0.5));
  ok('forecaster we falls back to wd', close(f.base('we', 3), 0.5));
  const day2 = new Array(48).fill(1.0);
  f.completeDay('2025-08-05', day2);                      // Tuesday -> EWMA
  ok('forecaster EWMA update', close(f.base('wd', 3), 0.15 * 1.0 + 0.85 * 0.5));
  const sat = new Array(48).fill(2.0);
  f.completeDay('2025-08-09', sat);                       // Saturday -> we seed
  ok('forecaster we seeds independently', close(f.base('we', 3), 2.0));
  ok('forecaster wd untouched by we day', close(f.base('wd', 3), 0.575));
}
// DST: null entries keep old profile value
{
  const f = new Forecaster();
  f.completeDay('2025-08-04', new Array(48).fill(1.0));
  const short = new Array(48).fill(0.4); short[2] = null;
  f.completeDay('2025-08-05', short);
  ok('forecaster null slot keeps old value', close(f.base('wd', 2), 1.0));
  ok('forecaster non-null slot updates', close(f.base('wd', 3), 0.15 * 0.4 + 0.85 * 1.0));
}
// intra-day ratio: dampened, ramping, never crossing day boundary
{
  const f = new Forecaster();
  f.completeDay('2025-08-04', new Array(48).fill(1.0));
  for (let s = 0; s < 8; s++) f.settle('2025-08-05', s, 2.0);   // running 2x profile
  // r=2, lambda = 0.75 * min(1, 8/16) = 0.375 -> ratio = 1 + 0.375*(2-1)
  ok('forecaster ratio ramps', close(f.ratio(), 1.375));
  const fc = f.forecast([{ date: '2025-08-05', slotOfDay: 20 },
                         { date: '2025-08-06', slotOfDay: 20 }], '2025-08-05');
  ok('forecaster ratio applies today', close(fc[0], 1.375));
  ok('forecaster ratio not tomorrow', close(fc[1], 1.0));
  f.completeDay('2025-08-05', new Array(48).fill(2.0));
  ok('forecaster ratio resets on day complete', f.ratio() === 1);
}
ok('forecaster dayType weekday', Forecaster.dayType('2025-08-04') === 'wd');
ok('forecaster dayType weekend', Forecaster.dayType('2025-08-09') === 'we');
```

- [ ] **Step 2: Run to verify failure** — `node test/units.mjs` — expected: module-load error (`causal.js` not found).

- [ ] **Step 3: Implement** — create `js/causal.js`:

```js
// Causal engine: forecaster + receding-horizon planner. The planner may only see
// current SOC, published prices, and forecast load — the causality guard test
// (test/causal.mjs) mutates the future and asserts decisions don't change.

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
```

- [ ] **Step 4: Run to verify pass** — `node test/units.mjs` — all PASS (previous 45 + new).

- [ ] **Step 5: Commit** — `g add js/causal.js test/units.mjs && g commit -m "causal: Forecaster — EWMA per-slot profile with dampened intra-day ratio"`

---

### Task 2: solveHorizon, scattered mode

**Files:**
- Modify: `js/optimiser.js` (export the internal helpers; `solveDay` stays for now — it dies in Task 4)
- Modify: `js/causal.js`
- Modify: `test/units.mjs`

**Interfaces:**
- Consumes from `optimiser.js` (add `export` keyword to each, no body changes): `chargeInSlot(cfg, loadT)`, `dischargeBuckets(imp, exp, load, s, allowExport, cfg)`, `cumAll(buckets)`, `valueFor(cum, E)`, `takeDischarge(buckets, E)`. Also existing exports `makeCfg`.
- Produces: `solveHorizon(soc0, imp, exp, loadF, cfg, mode, allowExport) -> plan` where plan =
  `{ chg: Map(t -> grid kWh), discharge: Map(t -> {load, export}), plannedSoc: Float64Array(T) (usable-band, end-of-slot), window: [t0,t1]|null }`.
  Semantics: `soc0` usable energy already in the pack (clamped to `cfg.cap`); horizon = array length; charge strictly precedes its own discharge (`c.t < d.t`); initial energy spendable anywhere; trajectory always within `[0, cfg.cap]`; only profitable pairs (`val > cost + 1e-9`); load-priority netting within each slot as in `solveDay`.

- [ ] **Step 1: Write the failing tests** — append to `test/units.mjs` (before `process.exit`):

```js
import { solveHorizon } from '../js/causal.js';
import { makeCfg } from '../js/optimiser.js';

const CFG = makeCfg({ capacity: 10, roundTrip: 1, dischargeFloorPct: 0,
                      inverterKw: 20, totalImportLimitKw: null, maxChargePrice: null,
                      exportLimitKw: null });

// cheap->dear pairing, twice, no export
{
  const p = solveHorizon(0, [10, 30, 10, 30], [0, 0, 0, 0], [0, 1, 0, 1], CFG, 'scattered', false);
  ok('horizon pairs cheap->dear #1', close(p.chg.get(0) ?? 0, 1));
  ok('horizon pairs cheap->dear #2', close(p.chg.get(2) ?? 0, 1));
  ok('horizon discharges to load', close(p.discharge.get(1).load, 1));
  ok('horizon no unprofitable charge', (p.chg.get(1) ?? 0) === 0);
}
// initial SOC spent at the best slot, no charging needed
{
  const p = solveHorizon(1, [30, 10], [0, 0], [1, 0], CFG, 'scattered', false);
  ok('horizon spends soc0 at best value', close(p.discharge.get(0).load, 1));
  ok('horizon soc0 needs no charge', p.chg.size === 0);
  ok('horizon plannedSoc drains', close(p.plannedSoc[0], 0));
}
// full pack blocks charging until after discharge (headroom)
{
  const cfgSmall = makeCfg({ capacity: 1, roundTrip: 1, dischargeFloorPct: 0,
                             inverterKw: 20, totalImportLimitKw: null,
                             maxChargePrice: null, exportLimitKw: null });
  const p = solveHorizon(1, [5, 30, 6, 31], [0, 0, 0, 0], [0, 1, 0, 1], cfgSmall, 'scattered', false);
  // soc0 serves slot 3 (val 31, best); slot-0 charge serves slot 1 — but pack is
  // full at slot 0, so the charge must land at slot 2 (after the... no: soc0 is
  // spent at slot 3, which frees no headroom before slot 1. Charging for slot 1
  // can only happen in slot 0 (before it) — infeasible while holding. Greedy
  // (desc value) assigns soc0 to 31 first, then 30's only source (slot 0) has
  // zero headroom -> slot 1 goes unserved by the battery.
  ok('horizon respects cap headroom', close(p.discharge.get(3).load, 1));
  ok('horizon blocked pair skipped', p.discharge.get(1) === undefined);
}
// energy-balance at the horizon: dear slot BEFORE cheap slot -> nothing to do
{
  const p = solveHorizon(0, [30, 10], [0, 0], [1, 0], CFG, 'scattered', false);
  ok('horizon never charges for beyond-horizon', p.chg.size === 0 && p.discharge.size === 0);
}
// maxChargePrice filter
{
  const cfgMax = { ...CFG, maxChgP: 5 };
  const p = solveHorizon(0, [10, 30], [0, 0], [0, 1], cfgMax, 'scattered', false);
  ok('horizon honours maxChargePrice', p.chg.size === 0);
}
// export + net settlement: exp > imp still serves load first
{
  const cfgX = makeCfg({ capacity: 10, roundTrip: 1, dischargeFloorPct: 0,
                         inverterKw: 2, totalImportLimitKw: null, maxChargePrice: null,
                         exportLimitKw: null });
  const p = solveHorizon(0, [5, 20], [0, 25], [0, 0.5], cfgX, 'scattered', true);
  const d = p.discharge.get(1);
  ok('horizon net settlement load first', close(d.load, 0.5));
  // slotOut = 1 kWh (2 kW): 0.5 to load, 0.5 to export
  ok('horizon export with remainder', close(d.export, 0.5));
}
// round-trip efficiency prices the charge correctly: spread must beat 1/eff
{
  const cfgE = makeCfg({ capacity: 10, roundTrip: 0.5, dischargeFloorPct: 0,
                         inverterKw: 20, totalImportLimitKw: null, maxChargePrice: null,
                         exportLimitKw: null });
  const pNo = solveHorizon(0, [10, 19], [0, 0], [0, 1], cfgE, 'scattered', false);
  ok('horizon eff kills thin spread', pNo.chg.size === 0);   // 10/0.5=20 > 19
  const pYes = solveHorizon(0, [10, 21], [0, 0], [0, 1], cfgE, 'scattered', false);
  ok('horizon eff allows fat spread', close(pYes.chg.get(0), 2)); // 1 kWh out needs 2 in
}
```

- [ ] **Step 2: Run to verify failure** — `node test/units.mjs` — import error (`solveHorizon` not exported).

- [ ] **Step 3: Implement** — in `js/optimiser.js`, add `export` before `chargeInSlot`, `dischargeBuckets`, `cumAll`, `valueFor`, `takeDischarge` (five keywords, nothing else). In `js/causal.js`, add:

```js
import { chargeInSlot, dischargeBuckets, cumAll, valueFor, takeDischarge } from './optimiser.js';

const EPS = 1e-12, MARGIN = 1e-9;

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
      for (const c of cand) {
        if (b.qty <= EPS) break;
        if (b.val <= c.cost + MARGIN) break;  // cand sorted: nothing cheaper left
        if (c.room <= EPS || c.t >= b.t) continue;
        const head = cfg.cap - maxOver(L, c.t, b.t);
        const q = Math.min(b.qty, slotRem[b.t], c.room * cfg.eff, head);
        if (q <= EPS) continue;
        chg.set(c.t, (chg.get(c.t) || 0) + q / cfg.eff);
        c.room -= q / cfg.eff;
        addRange(L, c.t, b.t, q);
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
  const bucketsFrom = (s) => dischargeBuckets(imp, exp, loadF, s, allowExport, cfg)
    .map((b) => ({ ...b, qty: Math.min(b.qty, slotRem[b.t]) }))
    .filter((b) => b.qty > EPS);
  let best = null;
  for (let i = 0; i < T; i++) {
    for (let len = 1; len <= T - i; len++) {
      if (imp[i + len - 1] > cfg.maxChgP) break;
      const head = cfg.cap - maxOver(L, i, i + len);
      if (head <= EPS) continue;
      let rem = head, cost = 0;
      const w = new Map();
      for (let t = i; t < i + len; t++) {
        const add = Math.min(chargeInSlot(cfg, loadF[t]) * cfg.eff, rem);
        if (add <= EPS) continue;
        cost += (add / cfg.eff) * imp[t];
        w.set(t, add / cfg.eff);
        rem -= add;
      }
      const E = head - rem;
      if (E <= MARGIN) continue;
      const bk = bucketsFrom(i + len);
      const gain = valueFor(cumAll(bk), E);
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
  addRange(L, first, best.s, packIn);         // conservative: full pack-in held from window start
  const { alloc } = takeDischarge(bucketsFrom(best.s), packIn);
  for (const [t, dd] of alloc) {
    const q = dd.load + dd.export;
    disRaw.set(t, (disRaw.get(t) || 0) + q);
    addRange(L, t, T, -q);
    addRange(L, best.s, t, 0);                // no-op; documents that energy sits in [s, t)
    slotRem[t] -= q;
  }
}
```

- [ ] **Step 4: Run to verify pass** — `node test/units.mjs` — all PASS. If the headroom test fails, print `p.plannedSoc` and re-check `maxOver` bounds (`[c.t, b.t)` — end exclusive).

- [ ] **Step 5: Commit** — `g add js/causal.js js/optimiser.js test/units.mjs && g commit -m "causal: solveHorizon scattered mode — soc0-aware greedy pairs with SOC trajectory"`

---

### Task 3: solveHorizon, contiguous mode tests

**Files:**
- Modify: `test/units.mjs`

**Interfaces:**
- Consumes: `solveHorizon` from Task 2 (`contiguousPass` was implemented there; this task proves it).

- [ ] **Step 1: Write the tests** — append to `test/units.mjs`:

```js
// contiguous: one unbroken charge window, discharge after it
{
  const p = solveHorizon(0, [10, 10, 30, 30], [0, 0, 0, 0], [0, 0, 1, 1], CFG, 'contiguous', false);
  ok('contig charges a window', close((p.chg.get(0) ?? 0) + (p.chg.get(1) ?? 0), 2));
  ok('contig window is contiguous', p.window !== null && p.window[1] - p.window[0] === 1);
  ok('contig discharges after', close(p.discharge.get(2).load + p.discharge.get(3).load, 2));
}
// contiguous window skips a cheap-dear-cheap split it would need scattered mode for
{
  const p = solveHorizon(0, [10, 40, 10, 30, 30], [0, 0, 0, 0, 0], [0, 0.2, 0, 1, 1],
                         CFG, 'contiguous', false);
  // one window only; the 40p slot never charges
  ok('contig never charges the dear middle', (p.chg.get(1) ?? 0) === 0);
}
// contiguous respects held soc0 headroom
{
  const cfgSmall = makeCfg({ capacity: 2, roundTrip: 1, dischargeFloorPct: 0,
                             inverterKw: 20, totalImportLimitKw: null,
                             maxChargePrice: null, exportLimitKw: null });
  const p = solveHorizon(1.5, [5, 30, 30], [0, 0, 0], [0, 1, 1], cfgSmall, 'contiguous', false);
  // soc0 1.5 spent on the two 30p slots (pass 1); window at slot 0 has 0.5 headroom
  ok('contig headroom-limited fill', close(p.chg.get(0) ?? 0, 0.5));
}
```

- [ ] **Step 2: Run** — `node test/units.mjs`. Task 2 implemented `contiguousPass`, so these should PASS immediately; if the headroom case fails, check that pass-1 spending precedes the window enumeration (it must — `contiguousPass` reads the post-pass-1 trajectory `L`).

- [ ] **Step 3: Commit** — `g add test/units.mjs && g commit -m "causal: contiguous-mode horizon tests"`

---

### Task 4: Replay loop — runSim becomes causal; batch machinery deleted

**Files:**
- Modify: `js/data.js` (rewrite `runSim` internals; DELETE `holdPass`, `cycleEdges` entirely; `dayKeys` stays)
- Modify: `js/optimiser.js` (DELETE `solveDay`; keep the exported helpers)
- Delete: `test/pymodel.py`, `test/fixtures.json`, `test/cycle_fixture.json`, `test/hold_fixture.json`, `test/validate.mjs`, `test/cycle.mjs`, `test/hold.mjs`, `test/gen_fixtures.py`, `test/gen_cycle_fixture.py`, `test/gen_hold_fixture.py`
- Create: `test/replay.mjs` (offline synthetic-year invariants)
- Rewrite: `test/e2e.mjs` (live-API smoke, invariant-based, no magic constants)

**Interfaces:**
- Consumes: `Forecaster`, `solveHorizon` (Tasks 1–2).
- Produces: `runSim({ usage, load, imp, exp, scTotalP, params })` returning the existing shape MINUS `carried`, PLUS `warmupDays` (number) and `replans` (number); each `slots[i]` entry gains `plannedSoc: number|null` (usable-band planned end-of-slot SOC from the plan active when slot i executed, plus `cfg.reserve`, i.e. display units — null for slots before the first plan covered them).
- Also produces (exported from `data.js`, used by tests and later by fixtures): `runReplay(usage, load, imp, exp, cfg, params) -> { slots, replans, warmupDays }` — the loop itself, so tests can drive it without the presentation layer. `runSim` wraps it.

- [ ] **Step 1: Write the failing test** — create `test/replay.mjs`:

```js
// Offline invariants on a synthetic no-DST year. No network, no CSV.
import { runSim } from '../js/data.js';

let fail = 0;
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) fail++; };

// Synthetic usage: fixed +00:00 offset (a fictional no-DST region is valid input).
function synth(days) {
  const wall = [], localFloat = [], kwh = [];
  const t0 = Date.UTC(2025, 0, 6);                      // a Monday
  for (let d = 0; d < days; d++) {
    for (let s = 0; s < 48; s++) {
      const ms = t0 + (d * 48 + s) * 1800000;
      wall.push(new Date(ms).toISOString().slice(0, 16));
      localFloat.push(ms);
      // evening-peaked house: 0.2 base + 0.6 through 17:00-21:00, weekend +25%
      const hh = s / 2, we = new Date(ms).getUTCDay() % 6 === 0;
      kwh.push((0.2 + (hh >= 17 && hh < 21 ? 0.6 : 0)) * (we ? 1.25 : 1));
    }
  }
  return { wall, localFloat, kwh, utc: wall };
}
// Agile-shaped synthetic prices: cheap overnight, evening spike.
const priceAt = (s) => { const hh = (s % 48) / 2;
  return hh < 6 ? 12 : hh >= 16 && hh < 19 ? 38 : 24; };

const DAYS = 40;
const usage = synth(DAYS);
const load = usage.kwh.slice();
const imp = load.map((_, i) => priceAt(i));
const exp = load.map((_, i) => priceAt(i) * 0.6);
const P = { capacity: 10, roundTrip: 0.9, dischargeFloorPct: 10, inverterKw: 5,
            exportLimitKw: null, totalImportLimitKw: null, maxChargePrice: null,
            cycle: 'scattered', allowExport: true, useBattery: true };

const r = runSim({ usage, load, imp, exp, scTotalP: 0, params: P });
const n = runSim({ usage, load, imp, exp, scTotalP: 0, params: { ...P, useBattery: false } });

ok('replay covers every slot', r.slots.length === DAYS * 48 && r.slots.every(Boolean));
ok('replay has no SOC violations', r.socViolations === 0);
ok('replay saves money', r.energy < n.energy - 1);
ok('replay no-battery baseline matches', Math.abs(n.energy - n.baseline) < 1e-6);
ok('replay reports warmup', r.warmupDays === 14);
ok('replay replans daily-ish', r.replans >= DAYS - 1 && r.replans <= DAYS * 3);
ok('replay carried is gone', !('carried' in r));
ok('replay plannedSoc present late', r.slots[DAYS * 48 - 10].plannedSoc !== null);
// causal cold start: day 1 has no load forecast, so no battery->load discharge
const day1 = r.slots.slice(0, 48);
ok('replay day-1 serves no load from battery', day1.every((s) => s.disLoad <= 1e-9));
// contiguous mode also runs clean
const rc = runSim({ usage, load, imp, exp, scTotalP: 0, params: { ...P, cycle: 'contiguous' } });
ok('replay contiguous clean', rc.socViolations === 0 && rc.energy < n.energy - 1);
// maxChargePrice honoured in execution
const rm = runSim({ usage, load, imp, exp, scTotalP: 0, params: { ...P, maxChargePrice: 13 } });
ok('replay maxChgP honoured', rm.slots.every((s) => s.chg <= 1e-9 || s.imp <= 13));

process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run to verify failure** — `node test/replay.mjs` — fails (`carried` still present / old windowed behaviour / `warmupDays` undefined).

- [ ] **Step 3: Implement the replay** — in `js/data.js`: delete `holdPass` and `cycleEdges` (and their comment blocks); replace `runSim`'s group/solve/hold section with:

```js
import { Forecaster, FORECAST_DEFAULTS, solveHorizon } from './causal.js';

const PUBLISH_HHMM = '16:00';
const slotOfDay = (wall) => {
  const hh = Number(wall.slice(11, 13)), mm = Number(wall.slice(14, 16));
  return hh * 2 + (mm >= 30 ? 1 : 0);
};

// The causal loop. Exported for tests and fixture generation.
export function runReplay(usage, load, imp, exp, cfg, params) {
  const T = load.length;
  const mode = params.cycle || 'contiguous';
  const allowExport = !!params.allowExport;
  const agileKey = dayKeys(usage, 'agile');            // tariff-day (23:00-23:00)
  const calKey = usage.wall.map((w) => w.slice(0, 10));
  // end index (exclusive) of each tariff-day
  const dayEnd = new Map();
  for (let i = 0; i < T; i++) dayEnd.set(agileKey[i], i + 1);

  const fc = new Forecaster();
  const slots = new Array(T);
  let soc = 0, replans = 0;
  let plan = null, planStart = 0;                       // plan covers [planStart, horizon)
  let horizon = dayEnd.get(agileKey[0]);
  let dayBuf = new Array(48).fill(null);                // actuals by slotOfDay

  const replanAt = (i, h) => {
    const entries = [];
    for (let t = i; t < h; t++) entries.push({ date: calKey[t], slotOfDay: slotOfDay(usage.wall[t]) });
    const loadF = fc.forecast(entries, calKey[i]);
    plan = solveHorizon(soc, imp.slice(i, h), exp.slice(i, h), loadF, cfg, mode, allowExport);
    planStart = i; horizon = h; replans++;
  };

  if (params.useBattery !== false) replanAt(0, horizon);

  for (let i = 0; i < T; i++) {
    // publication: first slot of each calendar day at/after 16:00 extends the horizon
    // to the end of the NEXT tariff-day; the new plan takes effect from the NEXT slot.
    const publishes = params.useBattery !== false &&
      usage.wall[i].slice(11, 16) >= PUBLISH_HHMM &&
      (i === 0 || usage.wall[i - 1].slice(11, 16) < PUBLISH_HHMM ||
       calKey[i - 1] !== calKey[i]);

    // execute the active plan against ACTUAL load
    let cin = 0, dl = 0, dx = 0, plannedSoc = null;
    if (plan && i >= planStart && i < horizon) {
      const n = i - planStart;
      const room = chargeInSlot(cfg, load[i]);          // import cap vs ACTUAL load
      cin = Math.min(plan.chg.get(n) || 0, room, (cfg.cap - soc) / cfg.eff);
      const dd = plan.discharge.get(n);
      if (dd) {
        const q = Math.min(dd.load + dd.export, soc + cin * cfg.eff, cfg.slotOut);
        dl = Math.min(load[i], q);
        dx = allowExport ? Math.min(q - dl, cfg.exportSlot) : 0;
      }
      plannedSoc = plan.plannedSoc[n] + cfg.reserve;
    }
    soc += cin * cfg.eff - dl - dx;

    slots[i] = { i, cin, dl, dx, soc, plannedSoc };

    // settle: forecaster learns the actual, day buffer fills
    const sd = slotOfDay(usage.wall[i]);
    fc.settle(calKey[i], sd, load[i]);
    dayBuf[sd] = dayBuf[sd] === null ? load[i] : (dayBuf[sd] + load[i]) / 2;  // DST repeat: average
    const dayDone = i + 1 === T || calKey[i + 1] !== calKey[i];
    if (dayDone) { fc.completeDay(calKey[i], dayBuf); dayBuf = new Array(48).fill(null); }

    if (publishes) {
      const next = dayEnd.get(agileKey[Math.min(dayEnd.get(agileKey[i]), T - 1)]) ?? T;
      replanAt(Math.min(i + 1, T - 1), Math.max(next, dayEnd.get(agileKey[i])));
    }
  }
  return { slots, replans, warmupDays: FORECAST_DEFAULTS.warmupDays };
}
```

Then rebuild `runSim`'s accounting loop on `runReplay`'s output — the existing per-slot/per-day aggregation code survives nearly verbatim, reading `cin/dl/dx/soc/plannedSoc` instead of the solution maps, keeping: `gImp = load[i] + cin - dl`, `slotP = gImp*imp[i] - dx*exp[i]`, `byDate` aggregation, `w0/w1` charge-window display, violation counting (`soc < -1e-6 || soc > cfg.cap + 1e-6`), and the returned totals — with `carried` deleted and `warmupDays`/`replans` passed through, and `slots[i].plannedSoc` added. In `js/optimiser.js` delete `solveDay` (lines 100–191) and its header comment reference.

- [ ] **Step 4: Delete the batch artifacts** —
`g rm test/pymodel.py test/fixtures.json test/cycle_fixture.json test/hold_fixture.json test/validate.mjs test/cycle.mjs test/hold.mjs test/gen_fixtures.py test/gen_cycle_fixture.py test/gen_hold_fixture.py`

- [ ] **Step 5: Rewrite `test/e2e.mjs`** — keep the module-level smoke value (drives the real `tariffs.js` fetch path), drop all `expect:` constants (they encode the batch model):

```js
// Live-API smoke: real Octopus prices + synthetic load through the causal engine.
// Invariant-based on purpose — exact figures live in test/causal.mjs fixtures.
import { buildPrices } from '../js/tariffs.js';
import { runSim } from '../js/data.js';

// ~60 recent days of synthetic evening-peaked usage (fixed-offset wall clock)
const wall = [], localFloat = [], kwh = [], utc = [];
const start = Date.now() - 63 * 86400000, t0 = start - (start % 1800000);
for (let i = 0; i < 60 * 48; i++) {
  const ms = t0 + i * 1800000;
  wall.push(new Date(ms).toISOString().slice(0, 16));
  utc.push(new Date(ms).toISOString());
  localFloat.push(ms);
  const hh = new Date(ms).getUTCHours();
  kwh.push(0.25 + (hh >= 17 && hh < 21 ? 0.55 : 0));
}
const usage = { wall, localFloat, kwh, utc };
const prices = await buildPrices({ importKey: 'agile', exportKey: 'agile-outgoing',
                                   region: 'J', instants: usage.utc, flatExport: null });
const P = { capacity: 32, roundTrip: 0.9, dischargeFloorPct: 10, inverterKw: 10,
            exportLimitKw: null, totalImportLimitKw: null, maxChargePrice: null,
            cycle: 'contiguous', allowExport: true, useBattery: true };
const load = usage.kwh.slice();
const args = { usage, load, imp: prices.imp, exp: prices.exp, scTotalP: 0 };
const wb = runSim({ ...args, params: P });
const nb = runSim({ ...args, params: { ...P, useBattery: false } });
const g5 = runSim({ ...args, params: { ...P, exportLimitKw: 5 } });

let fail = 0;
const ok = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) fail++; };
console.log(`with battery £${wb.energy.toFixed(2)}  no battery £${nb.energy.toFixed(2)}  G100-5kW £${g5.energy.toFixed(2)}`);
ok('live: battery saves', wb.energy < nb.energy);
ok('live: no SOC violations', wb.socViolations === 0 && g5.socViolations === 0);
ok('live: G100 cap costs money (or ties)', g5.energy >= wb.energy - 1e-6);
ok('live: export bounded by G100', g5.maxExportSlot <= 2.5 + 1e-9);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 6: Run everything offline** — `node test/units.mjs && node test/replay.mjs && node test/dom.mjs` — units + replay PASS; `dom.mjs` id-check still passes (app.js untouched so far; its `boundary` reference still resolves — removed in Task 6). Run `node test/e2e.mjs` too (needs network; skip only if offline).

- [ ] **Step 7: Commit** — `g add -A && g commit -m "causal: runSim is now the cold-start replay loop; batch solver, hold pass, cycle fixed-point and their fixtures deleted"`

---

### Task 5: Python reference, parity fixtures, causality guard

**Files:**
- Create: `test/causal_model.py` (reference implementation: Forecaster + solveHorizon + replay, mirroring Tasks 1–4 function-for-function; same constants, same tie-breaks — stable sorts everywhere, `sort(key=lambda b: -b.val)` mirrors JS's stable desc sort)
- Create: `test/gen_causal_fixtures.py` (deterministic generator, stdlib only)
- Create: `test/causal_fixture.json` (generated artifact, committed)
- Create: `test/causal.mjs` (parity + causality guard)

**Interfaces:**
- Consumes: `runReplay`, `solveHorizon`, `Forecaster` (JS side); the fixture JSON contract below.
- Produces: `test/causal_fixture.json` =
  `{ "meta": {...}, "usage": { "wall": [...], "localFloat": [...] }, "load": [...], "imp": [...], "exp": [...], "params": {...}, "expected": { "slots": [{ "cin":, "dl":, "dx":, "soc": }...], "replans": N } }` — one object per case, three cases: scattered+export, contiguous no-export, scattered with `exportLimitKw` and `maxChargePrice` set.
- Python mirrors the JS constants verbatim: `EPS=1e-12`, `MARGIN=1e-9`, publication `16:00`, forecast defaults.

- [ ] **Step 1: Write `test/causal_model.py`** — a direct transcription of `js/causal.js` + `runReplay` into Python (same names: `Forecaster`, `solve_horizon`, `run_replay`; `Fraction`-free float arithmetic — parity is float-exact because both sides do the same float ops in the same order). Include at the bottom a `if __name__ == '__main__':` self-check that runs the three fixture cases and prints totals.

- [ ] **Step 2: Write `test/gen_causal_fixtures.py`**:

```python
#!/usr/bin/env python3
"""Regenerate test/causal_fixture.json from the Python reference. Deterministic."""
import json, math
from causal_model import run_replay, make_cfg

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
            import datetime
            wall.append(datetime.datetime.utcfromtimestamp(ms / 1000).strftime('%Y-%m-%dT%H:%M'))
            lf.append(ms)
            hh = s / 2
            we = datetime.datetime.utcfromtimestamp(ms / 1000).weekday() >= 5
            load.append(round((0.2 + (0.6 if 17 <= hh < 21 else 0)) * (1.25 if we else 1)
                              * (0.8 + 0.4 * next(rnd)), 6))
            base = 12 if hh < 6 else 38 if 16 <= hh < 19 else 24
            imp.append(round(base * (0.9 + 0.2 * next(rnd)), 4))
            exp.append(round(base * 0.6 * (0.9 + 0.2 * next(rnd)), 4))
    return {'wall': wall, 'localFloat': lf}, load, imp, exp

CASES = [
    ('scattered-export',  dict(cycle='scattered',  allowExport=True,  exportLimitKw=None, maxChargePrice=None)),
    ('contig-noexport',   dict(cycle='contiguous', allowExport=False, exportLimitKw=None, maxChargePrice=None)),
    ('scattered-capped',  dict(cycle='scattered',  allowExport=True,  exportLimitKw=3.0,  maxChargePrice=20.0)),
]
BASE = dict(capacity=12.0, roundTrip=0.9, dischargeFloorPct=10, inverterKw=5.0,
            totalImportLimitKw=None, useBattery=True)
out = []
for name, extra in CASES:
    usage, load, imp, exp = synth(35, seed=42)
    params = {**BASE, **extra}
    slots, replans, warmup = run_replay(usage, load, imp, exp, make_cfg(params), params)
    out.append({'meta': {'name': name}, 'usage': usage, 'load': load, 'imp': imp,
                'exp': exp, 'params': params,
                'expected': {'slots': [{'cin': s['cin'], 'dl': s['dl'],
                                        'dx': s['dx'], 'soc': s['soc']} for s in slots],
                             'replans': replans}})
json.dump(out, open('causal_fixture.json', 'w'))
print(f"wrote {len(out)} cases")
```

- [ ] **Step 3: Generate** — `cd test && python3 gen_causal_fixtures.py` — writes `causal_fixture.json`.

- [ ] **Step 4: Write `test/causal.mjs`** (parity + causality guard):

```js
// (a) exact JS ≡ Python parity on the committed fixtures;
// (b) causality guard: garbage in the unpublished future must not change the past.
import { readFileSync } from 'node:fs';
import { runReplay } from '../js/data.js';
import { makeCfg } from '../js/optimiser.js';

const cases = JSON.parse(readFileSync(new URL('causal_fixture.json', import.meta.url)));
let fail = 0;
const ok = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) fail++; };

for (const c of cases) {
  const cfg = makeCfg(c.params);
  const { slots, replans } = runReplay(c.usage, c.load, c.imp, c.exp, cfg, c.params);
  let worst = 0;
  slots.forEach((s, i) => {
    const e = c.expected.slots[i];
    worst = Math.max(worst, Math.abs(s.cin - e.cin), Math.abs(s.dl - e.dl),
                     Math.abs(s.dx - e.dx), Math.abs(s.soc - e.soc));
  });
  ok(`parity ${c.meta.name} (worst ${worst.toExponential(1)})`, worst <= 1e-9);
  ok(`parity ${c.meta.name} replans`, replans === c.expected.replans);

  // causality: cut at 15:00 on day 20 — everything at/after the cut is garbage,
  // and the tariff-day published AT the next 16:00 is garbage too.
  const cut = 20 * 48 + 30;                       // slot index of 15:00 day 20
  const imp2 = c.imp.map((v, i) => (i >= cut ? 999 : v));
  const exp2 = c.exp.map((v, i) => (i >= cut ? -999 : v));
  const load2 = c.load.map((v, i) => (i >= cut ? 17 : v));
  const a = runReplay(c.usage, c.load, c.imp, c.exp, cfg, c.params).slots;
  const b = runReplay(c.usage, load2, imp2, exp2, cfg, c.params).slots;
  let leak = false;
  for (let i = 0; i < cut; i++) {
    if (Math.abs(a[i].cin - b[i].cin) > 0 || Math.abs(a[i].dl - b[i].dl) > 0 ||
        Math.abs(a[i].dx - b[i].dx) > 0) leak = true;
  }
  ok(`causality ${c.meta.name}: no future leakage before the cut`, !leak);
}
process.exit(fail ? 1 : 0);
```

Note the cut choice: 15:00 is before the 16:00 publication, so *no* plan made before the cut may legitimately contain any post-cut price — decisions before `cut` must be bit-identical. (A cut at e.g. 17:00 would be wrong: the 16:00 plan legitimately read prices beyond it.)

- [ ] **Step 5: Run** — `node test/causal.mjs` — all parity and causality checks PASS. Any parity failure means the Python transcription diverged: diff the first mismatching slot's plan inputs on both sides (print `replanAt` inputs at the plan covering that slot).

- [ ] **Step 6: Commit** — `g add test/causal_model.py test/gen_causal_fixtures.py test/causal_fixture.json test/causal.mjs && g commit -m "causal: Python reference, exact parity fixtures, causality guard"`

---

### Task 6: UI demolition + warm-up marker + planned-SOC overlay + README

**Files:**
- Modify: `index.html` (remove the "Discharge by" select block: the `<label>Discharge by</label>`, the `<select id="boundary">…</select>`, and the note beginning "“Next charge cycle” keeps remaining charge…" — `index.html:108-116`)
- Modify: `js/app.js` (drop `boundary: $('boundary').value,` at `js/app.js:203`; drop the carried clause at `js/app.js:465`; add warm-up line; add planned-SOC path to `drawDayChart`)
- Modify: `test/browser.py` (replace exact-£ assertions with structural ones)
- Modify: `README.md` (Model section rewrite)

**Interfaces:**
- Consumes: `runSim` fields `warmupDays`, `slots[].plannedSoc` (Task 4).

- [ ] **Step 1: dom test first** — `node test/dom.mjs` currently PASSES with `boundary` present; after the HTML+JS edits it must still pass (the id disappears from both sides together). Run it before and after.

- [ ] **Step 2: Edit `index.html`** — delete lines 108–116 (Discharge-by label + select + note). Keep the "Cycle rule" select and the max-charge-price input.

- [ ] **Step 3: Edit `js/app.js`** —
  1. Remove `boundary: $('boundary').value,` (line 203).
  2. Replace the carried clause at line 465 — the expression fragment
     `(withBat.carried > 0.5 ? \` · ${withBat.carried.toFixed(0)} kWh carried across window boundaries\` : '') +`
     with
     `(withBat.warmupDays ? \` · first ${withBat.warmupDays} days are forecast warm-up (cold start)\` : '') +`
  3. In `drawDayChart` (`js/app.js:631`), the function signature gains nothing — planned SOC comes in on the slots. After the `socPath` line add:

```js
  const planPts = slots.map((s, i) => s.plannedSoc === null || s.plannedSoc === undefined
    ? null : `${x(i).toFixed(1)},${ys(Math.min(s.plannedSoc, cap)).toFixed(1)}`);
  const planPath = planPts.some(Boolean)
    ? 'M' + planPts.filter(Boolean).join(' L') : '';
```

  and render it after the SOC fill path:

```js
    ${planPath ? `<path d="${planPath}" fill="none" stroke="var(--batt)" stroke-width="1" stroke-dasharray="3 3" opacity=".7"/>` : ''}
```

  4. `showDay`'s `slots` objects are built in `runSim` — confirm `plannedSoc` flows through (Task 4 added it to `slots[]`).
- [ ] **Step 4: Edit `test/browser.py`** — scenario 2 (`test/browser.py:283-291`) asserts exact strings like `"G100 export limit 5kW = £757.30"`. Replace every exact-£ equality with structure checks: totals element non-empty and parses as `£\d`, `"G100 limit" in statsNote` stays. Exact values are fixture territory now (`causal.mjs`).

- [ ] **Step 5: Rewrite README Model section** — replace the window/hold/discharge-by bullets (README lines describing "One cycle per discharge window", "Discharge by", "Hold pass", "Perfect foresight") with:

```markdown
- **Causal replay.** Run replays your CSV as accelerated real time. The planner
  only ever sees: the battery's current charge, prices that have been published
  (Agile day-ahead lands at 16:00), and a load *forecast* built from days it has
  already lived through. It starts knowing nothing — the first two weeks are a
  cold-start warm-up while the forecast learns your house.
- **Planning.** At 16:00 each day the plan is recomputed from the next half hour
  out to 23:00 tomorrow: charge in the cheapest slots, hold, serve the house and
  export through the peaks — sized against forecast load, never actual future
  load. Energy is only charged if it can be placed profitably before the end of
  the known-price horizon.
- **Execution.** Each half hour the plan meets reality: discharge covers the
  slot's actual load first (a meter settles one direction per half hour), any
  planned remainder exports under the G100 cap, and the forecast learns from the
  actual. A dashed line on the day chart shows what the plan expected the state
  of charge to be; the solid area shows what actually happened.
- Numbers from this engine are lower than the old perfect-foresight build's —
  deliberately. Those assumed a year of hindsight; these are achievable.
```

- [ ] **Step 6: Run** — `node test/units.mjs && node test/replay.mjs && node test/causal.mjs && node test/dom.mjs` — all PASS (dom first section; its FlowDiagram half still needs the Downloads CSV and is excused).

- [ ] **Step 7: Commit** — `g add -A && g commit -m "causal: UI — remove Discharge-by and carried, add warm-up note and planned-SOC overlay, README rewrite"`

---

### Task 7: Full verification + deploy

**Files:** none new.

- [ ] **Step 1: Full offline suite** — `node test/units.mjs && node test/replay.mjs && node test/causal.mjs && node test/dom.mjs` — expected: all PASS (dom's CSV half excused if the fixture CSV is still absent).
- [ ] **Step 2: Live-API smoke** — `node test/e2e.mjs` — PASS (network required).
- [ ] **Step 3: Deploy** — `g fetch origin && g rebase origin/main && g push` (push = deploy to GitHub Pages).
- [ ] **Step 4: Verify live** — poll `gh api repos/nashant/energy-battery-sim/pages/builds/latest --jq .commit` until it equals `g rev-parse HEAD`; then WebFetch `https://battery.shedbuilt.link/?v=<sha>` and confirm the page text contains "forecast warm-up" copy and no longer contains "Discharge by".
- [ ] **Step 5: Report** — totals from `test/e2e.mjs` output quoted in the summary, with the explicit note that figures are lower than the retired batch numbers by design.
