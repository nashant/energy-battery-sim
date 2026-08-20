# Payback Realism & Sensitivity Sweeps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add year-on-year price escalation and a heat-pump full ledger (capex + gas-bill credit) to the payback card, and opt-in capacity/inverter sensitivity sweep tables.

**Architecture:** Pure helpers (`paybackYears` with escalation, `gasBillPounds`, sweep-value grids) live in `js/data.js` where node test scripts can import them; all DOM wiring stays in `js/app.js`. No solver changes — `js/optimiser.js`, the solve path in `js/data.js`, `test/pymodel.py`, and all fixtures are untouched.

**Tech Stack:** Vanilla ES modules, no build step, no package.json. Tests are plain node scripts (`node test/<name>.mjs`) printing PASS/FAIL; `test/e2e.mjs` hits the live Octopus API; `test/browser.py` drives Playwright (CSP blocks `wait_for_function` string eval — selector waits only).

## Global Constraints

- Spec: `docs/specs/2026-08-06-payback-realism-and-sweeps-design.md` (approved 2026-08-06).
- This project is NOT a git repo — there are no commit steps. Each task ends by running the offline suites: `node test/dom.mjs && node test/units.mjs` (units.mjs created in Task 1).
- Parity suites `node test/validate.mjs`, `node test/cycle.mjs`, `node test/hold.mjs` must pass **unchanged** at the end (Task 7). Any diff means the solver was accidentally touched.
- The "Saving vs current" card keeps its like-for-like tariff-switch meaning (HP load on both sides). Only the **payback** card uses the full ledger.
- New input ids: `escPct`, `hpCost`, `gasUnitRate`, `gasScPerDay`. `test/dom.mjs` cross-checks every id used in JS against index.html automatically.
- All new £/yr figures use the existing annualisation `annual = 365 / withBat.nDays`.
- Deployment is Task 8 only (site copy sync + `kubectl apply`); git commits of the k8s manifests are Anthony's.

---

### Task 1: Escalated `paybackYears` in data.js

**Files:**
- Modify: `js/data.js` (append near the bottom, after `currentTariffTotal`)
- Modify: `js/app.js:346-349` (delete local `paybackYears`, import from data.js)
- Create: `test/units.mjs`

**Interfaces:**
- Produces: `paybackYears(cost, savePerYear, escPct = 0) -> number | null` exported from `js/data.js`. Null when `cost <= 0` or `savePerYear <= 0`. `escPct` in percent (5 = 5%/yr).

- [ ] **Step 1: Write the failing test**

Create `test/units.mjs`:

```js
// Unit tests for the pure helpers in js/data.js — no network, no DOM.
import { paybackYears } from '../js/data.js';

let fail = 0;
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) fail++; };
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// e = 0 degenerates to plain division
ok('payback e=0 is cost/save', close(paybackYears(3500, 1012, 0), 3500 / 1012));
ok('payback escPct omitted is cost/save', close(paybackYears(3500, 1012), 3500 / 1012));

// closed form: n = ln(1 + C·e/S) / ln(1+e); C=3500 S=1000 e=5% -> 3.30525…
const n = paybackYears(3500, 1000, 5);
ok('payback 5%/yr closed form', close(n, Math.log(1 + 3500 * 0.05 / 1000) / Math.log(1.05)));
// cross-check: cumulative saving S·((1+e)^n − 1)/e equals the cost at the crossing
ok('payback 5%/yr cumulative crossing', close(1000 * (Math.pow(1.05, n) - 1) / 0.05, 3500, 1e-6));

// guards
ok('payback null on zero cost', paybackYears(0, 1000, 5) === null);
ok('payback null on negative saving', paybackYears(3500, -5, 5) === null);
ok('payback null on zero saving', paybackYears(3500, 0, 5) === null);

process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/src/energy-battery-sim && node test/units.mjs`
Expected: FAIL to even run — `SyntaxError: The requested module '../js/data.js' does not provide an export named 'paybackYears'`

- [ ] **Step 3: Write minimal implementation**

Append to `js/data.js`:

```js
// Repay time in years when the yearly saving grows escPct %/yr: cumulative saving
// through year n is S·((1+e)^n − 1)/e; solve for the crossing with the cost.
export const paybackYears = (cost, savePerYear, escPct = 0) => {
  if (!(cost > 0) || !(savePerYear > 0)) return null;
  const e = (escPct || 0) / 100;
  if (e <= 0) return cost / savePerYear;
  return Math.log(1 + cost * e / savePerYear) / Math.log(1 + e);
};
```

In `js/app.js`: delete lines 347-348 (`const paybackYears = (cost, savePerYear) => cost > 0 && savePerYear > 0 ? cost / savePerYear : null;`) and add `paybackYears` to the import list from `./data.js` on line 3.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/units.mjs && node test/dom.mjs`
Expected: all PASS (dom.mjs proves app.js still parses and every id resolves).

### Task 2: `gasBillPounds` in data.js

**Files:**
- Modify: `js/data.js` (append after `paybackYears`)
- Modify: `test/units.mjs` (append cases)

**Interfaces:**
- Consumes: `hpInfo` shape from `heatPumpFromGas` (`{ gasKwh, unmatchedKwh, … }`, data.js:129-131) or `heatPumpSynthetic` (no `gasKwh` key).
- Produces: `gasBillPounds(hpInfo, unitRateP, scPerDayP, nDays) -> number` (£ over the CSV window, NOT annualised). Returns 0 when there is no gas data (`gasKwh` absent) or no positive unit rate — the caller warns in those cases.

- [ ] **Step 1: Write the failing test**

Append to `test/units.mjs` (before `process.exit`):

```js
import { gasBillPounds } from '../js/data.js';

// 5000 kWh matched gas (5200 metered − 200 unmatched) at 6.29p + 31.66p/day over 364 days
const bill = gasBillPounds({ gasKwh: 5200, unmatchedKwh: 200 }, 6.29, 31.66, 364);
ok('gas bill matched kWh + SC', close(bill, (5000 * 6.29 + 31.66 * 364) / 100, 1e-9));
ok('gas bill blank SC is rate only', close(gasBillPounds({ gasKwh: 5200, unmatchedKwh: 200 }, 6.29, null, 364), 5000 * 6.29 / 100));
ok('gas bill zero without unit rate', gasBillPounds({ gasKwh: 5200, unmatchedKwh: 200 }, null, 31.66, 364) === 0);
ok('gas bill zero for synthetic info', gasBillPounds({ hpKwh: 3000 }, 6.29, 31.66, 364) === 0);
ok('gas bill zero for null info', gasBillPounds(null, 6.29, 31.66, 364) === 0);
```

(Move the `process.exit(fail ? 1 : 0);` line to stay last in the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/units.mjs`
Expected: FAIL — no export named `gasBillPounds`.

- [ ] **Step 3: Write minimal implementation**

Append to `js/data.js`:

```js
// £ the gas meter cost over the CSV window: matched gas kWh at the unit rate plus the
// standing charge. Matched = metered minus the kWh that fell outside the electricity
// date range (heatPumpFromGas already reports both). No gas data or no rate -> 0;
// the caller is responsible for warning that the credit is missing.
export function gasBillPounds(hpInfo, unitRateP, scPerDayP, nDays) {
  if (!hpInfo || hpInfo.gasKwh === undefined || !(unitRateP > 0)) return 0;
  const matched = Math.max(0, hpInfo.gasKwh - hpInfo.unmatchedKwh);
  return (matched * unitRateP + (scPerDayP || 0) * nDays) / 100;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/units.mjs && node test/dom.mjs`
Expected: all PASS.

### Task 3: New inputs in index.html + params()

**Files:**
- Modify: `index.html` — cost inputs block (the one holding `batteryCost`/`inverterCost`/`installCost`), and section "6 · Heat pump" (around lines 107-123)
- Modify: `js/app.js` — `params()` (lines 156-184) and the hpMode change handler (line 62-64)

**Interfaces:**
- Produces: `params()` gains `escPct` (number, 0 when blank), `hpCost` (number|null), `gasUnitRate` (number|null), `gasScPerDay` (number|null). Task 4 and Task 5 consume `p.escPct`, `p.hpCost`, `p.gasUnitRate`, `p.gasScPerDay`.

- [ ] **Step 1: Add the inputs**

In `index.html`, inside the grid/div that contains the `installCost` input, append alongside it:

```html
<div><label>Energy price rise (%/yr)</label><input type="number" id="escPct" placeholder="0, e.g. 3–5" step="0.1"></div>
```

In section "6 · Heat pump", after the `hpMode` select (outside `hpGasWrap`, so synthetic mode sees it too):

```html
<div id="hpCostWrap" class="hide">
  <label>Heat pump installed cost (£)</label>
  <input type="number" id="hpCost" placeholder="0" step="50">
</div>
```

Inside `hpGasWrap`, after the boilerEff/COP pair:

```html
<div class="grid2">
  <div><label>Gas unit rate (p/kWh)</label><input type="number" id="gasUnitRate" placeholder="for the gas bill credit" step="0.01"></div>
  <div><label>Gas standing charge (p/day)</label><input type="number" id="gasScPerDay" placeholder="0" step="0.01"></div>
</div>
```

(Match the wrapper/grid class names actually used around `boilerEff` in index.html:119-122 — reuse whatever two-column class that block uses rather than inventing one.)

- [ ] **Step 2: Wire params() and visibility**

In `js/app.js` `params()` return object, after `installCost`:

```js
    escPct: num('escPct') || 0,
```

and after `cop`:

```js
    hpCost: num('hpCost'),
    gasUnitRate: num('gasUnitRate'),
    gasScPerDay: num('gasScPerDay'),
```

In the hpMode change handler (app.js:62-64, where `hpGasWrap` is toggled), add:

```js
  $('hpCostWrap').classList.toggle('hide', m === 'none');
```

- [ ] **Step 3: Run the id cross-check**

Run: `node test/dom.mjs && node test/units.mjs`
Expected: PASS — the four new ids are referenced from app.js and defined in index.html, so the cross-check stays green.

### Task 4: Full-ledger payback card

**Files:**
- Modify: `js/app.js` — run handler (lines ~295-322: `save`/`cost`/`annual`/`pbCur`/`pbBatt` block and the `card('Payback', …)` template, plus the warnings block at ~317-322), `renderCompare` (line ~351 and its payback cell at ~367), and the `renderCompare(rows, cur, systemCost(p))` call site (~270).

**Interfaces:**
- Consumes: `paybackYears(cost, save, escPct)` (Task 1), `gasBillPounds(info, rate, sc, nDays)` (Task 2), `p.escPct/hpCost/gasUnitRate/gasScPerDay` (Task 3), existing `currentTariffTotal(usage, extraLoad, override)`, `curOverride(p)`, `systemCost(p)`, `gbp()`, `fmtYears()`, `card()`.
- Produces: payback card text of the form
  `£3,500 battery + £5,000 heat pump ÷ £1,410/yr · incl. £398/yr gas bill removed · prices rising 3%/yr · 3.4 yrs counting only what the battery adds` (segments appear only when applicable).

- [ ] **Step 1: Replace the payback computation**

In the run handler, replace the block

```js
  const save = cur.total - withBat.total;
  const cost = systemCost(p);
  const annual = 365 / withBat.nDays;      // CSV period -> per-year
  const pbBatt = paybackYears(cost, withBat.savedVsNoBattery * annual);
  const pbCur = paybackYears(cost, save * annual);
```

with

```js
  const save = cur.total - withBat.total;
  const cost = systemCost(p);
  const annual = 365 / withBat.nDays;      // CSV period -> per-year
  // Full-ledger payback: do-nothing = current tariff on RAW usage (no heat pump) plus
  // the gas bill; new world = withBat.total (already includes any heat pump load).
  // With no HP cost and no gas credit this reduces exactly to save × annual.
  const hpCost = p.hpCost || 0;
  const gasBill = p.hpMode === 'gas'
    ? gasBillPounds(info, p.gasUnitRate, p.gasScPerDay, withBat.nDays) : 0;
  const invest = cost + hpCost;
  const pbSave = (hpCost > 0 || gasBill > 0
    ? currentTariffTotal(state.usage, null, curOverride(p)).total + gasBill - withBat.total
    : save) * annual;
  const pbBatt = paybackYears(cost, withBat.savedVsNoBattery * annual, p.escPct);
  const pbCur = paybackYears(invest, pbSave, p.escPct);
```

(`info` is the hpInfo already in scope from `buildLoad(p)` — the run handler destructures `{ load, add, info }` at line ~213.)

- [ ] **Step 2: Reword the payback card**

Replace the `card('Payback', …)` template with:

```js
    ${invest > 0 ? card('Payback', fmtYears(pbCur), [
      (hpCost > 0 ? `${gbp(cost)} battery + ${gbp(hpCost)} heat pump` : gbp(invest)) +
        ` ÷ ${gbp(pbSave)}/yr vs your current setup`,
      ...(gasBill > 0 ? [`incl. ${gbp(gasBill * annual)}/yr gas bill removed`] : []),
      ...(p.escPct > 0 ? [`prices rising ${p.escPct}%/yr`] : []),
      ...(pbBatt !== null ? [`${fmtYears(pbBatt)} counting only what the battery adds`] : []),
    ].join(' · ')) : ''}
```

(Keep the surrounding `$('cards').innerHTML` template otherwise identical; the guard changes from `cost > 0` to `invest > 0` so an HP-cost-only entry still shows a card.)

- [ ] **Step 3: Add the missing-credit warnings**

In the warnings block (after the `unmatchedKwh` warning):

```js
  if (hpCost > 0 && p.hpMode === 'synthetic') {
    w.push('Synthetic heat pump: no gas bill credit — payback counts the heat pump cost ' +
           'but not the gas saving. Use a gas CSV for the full ledger.');
  }
  if (hpCost > 0 && p.hpMode === 'gas' && !(p.gasUnitRate > 0)) {
    w.push('No gas unit rate given — payback counts the heat pump cost but no gas bill credit.');
  }
```

- [ ] **Step 4: Escalate the compare table's payback column**

Change `renderCompare(rows, cur, cost = 0)` to `renderCompare(rows, cur, cost = 0, escPct = 0)`; in its payback cell change `paybackYears(cost, (cur.total - r.wb.total) * 365 / r.wb.nDays)` to `paybackYears(cost, (cur.total - r.wb.total) * 365 / r.wb.nDays, escPct)`; change the call site to `renderCompare(rows, cur, systemCost(p), p.escPct)`. (The compare table intentionally keeps battery-system cost only — it ranks tariff switches, not the HP project.)

- [ ] **Step 5: Run the offline suites**

Run: `node test/dom.mjs && node test/units.mjs`
Expected: PASS.

- [ ] **Step 6: Eyeball in a real browser**

Run: `python3 -m http.server 8099` from the project dir (check first whether one is already listening: `ss -ltn | grep 8099`). Load http://localhost:8099, drop the usage CSV (or rely on the IndexedDB restore), set escalation 3, HP mode gas + gas CSV + HP cost 5000 + gas rate 6.29/SC 31.66, Run. Confirm: payback card shows the split cost, the gas credit line, the escalation line; setting everything back to defaults reproduces the old card exactly (£716.95 total, same payback).

### Task 5: Sweep grids in data.js

**Files:**
- Modify: `js/data.js` (append)
- Modify: `test/units.mjs` (append cases)

**Interfaces:**
- Produces: `sweepCapacities(cap) -> number[]` (pack × [0.5, 0.625, 0.75, 0.875, 1, 1.125, 1.25], 0.1-rounded, deduped, ascending, always contains `cap`); `sweepInverters(kw) -> number[]` ([3.6, 5, 6, 8, 10, 12] ∪ {kw}, deduped, ascending). Task 6 consumes both.

- [ ] **Step 1: Write the failing test**

Append to `test/units.mjs`:

```js
import { sweepCapacities, sweepInverters } from '../js/data.js';

const caps = sweepCapacities(32);
ok('capacity grid for 32', JSON.stringify(caps) === JSON.stringify([16, 20, 24, 28, 32, 36, 40]));
ok('capacity grid contains the input', sweepCapacities(13.5).includes(13.5));
ok('capacity grid rounds to 0.1', sweepCapacities(13.5).every((v) => close(v * 10, Math.round(v * 10))));
const invs = sweepInverters(10);
ok('inverter grid standard', JSON.stringify(invs) === JSON.stringify([3.6, 5, 6, 8, 10, 12]));
ok('inverter grid inserts odd size', JSON.stringify(sweepInverters(7)) === JSON.stringify([3.6, 5, 6, 7, 8, 10, 12]));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/units.mjs` — Expected: FAIL, missing exports.

- [ ] **Step 3: Write minimal implementation**

Append to `js/data.js`:

```js
// Sensitivity-sweep grids. Capacity sweeps relative to the configured pack; inverter
// sweeps a fixed ladder of common hybrid sizes plus the configured one.
export const sweepCapacities = (cap) =>
  [...new Set([0.5, 0.625, 0.75, 0.875, 1, 1.125, 1.25]
    .map((m) => Math.round(cap * m * 10) / 10))].sort((a, b) => a - b);
export const sweepInverters = (kw) =>
  [...new Set([3.6, 5, 6, 8, 10, 12, kw])].sort((a, b) => a - b);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/units.mjs && node test/dom.mjs` — Expected: PASS.

### Task 6: Sensitivity section UI

**Files:**
- Modify: `index.html` — new section after the results cards / before or after the day explorer, matching surrounding section markup
- Modify: `js/app.js` — imports, run-handler hook, new `runSweeps` handler + `sweepTables` renderer

**Interfaces:**
- Consumes: `sweepCapacities`/`sweepInverters` (Task 5), `paybackYears` (Task 1), `state.run = { p, prices, withBat, noBat, cur, hpInfo }` (set by the run handler), `runSim`, `buildLoad`, `status()`, `showError()`, `gbp()`, `fmtYears()`.
- Produces: `#sweepOut` containing `<table id="sweepCapTable">` and `<table id="sweepInvTable">`; the row whose value equals the configured setting carries class `cur`. `test/browser.py` (Task 7) consumes these ids.

- [ ] **Step 1: Add the section markup**

In `index.html`, after the element containing the results cards (`id="cards"`'s section), add (copying the heading/section classes of the neighbouring sections):

```html
<section id="sensSection" class="hide">
  <h2>Sensitivity</h2>
  <div class="note">Re-runs the optimiser at nearby pack sizes and inverter ratings,
    everything else unchanged. ~13 runs, a few seconds each.</div>
  <button id="runSweeps">Run sweeps</button>
  <div id="sweepOut"></div>
</section>
```

- [ ] **Step 2: Reveal + reset it on every successful Run**

In the run handler, next to `$('results').classList.remove('hide')` (line ~290), add:

```js
  $('sensSection').classList.remove('hide');
  $('sweepOut').innerHTML = '';            // stale sweeps must not outlive their inputs
```

- [ ] **Step 3: Implement the sweep handler**

Add to `js/app.js` (near the compare handler; import `sweepCapacities`, `sweepInverters` from `./data.js`):

```js
$('runSweeps').onclick = async () => {
  if (!state.run) return;
  const { p, prices, withBat, cur } = state.run;
  $('runSweeps').disabled = true;
  try {
    const { load } = buildLoad(p);
    const base = { usage: state.usage, load, imp: prices.imp, exp: prices.exp,
                   scTotalP: prices.scTotalP };
    const annual = 365 / withBat.nDays;
    const one = async (key, v, unit) => {
      status(`<span class="spinner"></span> sweep: ${v} ${unit}…`);
      await new Promise((r) => setTimeout(r, 0));
      const r0 = v === p[key] ? withBat
        : runSim({ ...base, params: { ...p, [key]: v, useBattery: true } });
      return { v, total: r0.total };
    };
    const caps = [];
    for (const v of sweepCapacities(p.capacity)) caps.push(await one('capacity', v, 'kWh pack'));
    const invs = [];
    for (const v of sweepInverters(p.inverterKw)) invs.push(await one('inverterKw', v, 'kW inverter'));
    $('sweepOut').innerHTML = sweepTables(caps, invs, p, cur, annual);
    status('done');
  } catch (e) {
    showError(e.message); status('');
  } finally {
    $('runSweeps').disabled = false;
  }
};

// Two tables. Marginal columns compare consecutive rows; the capacity table also prices
// the marginal kWh at batteryCost/capacity (blank when no battery cost is given).
function sweepTables(caps, invs, p, cur, annual) {
  const perKwh = p.batteryCost > 0 ? p.batteryCost / p.capacity : null;
  // Total/Saving columns use the same CSV-window measure as the main cards (so the
  // current row matches the "Saving vs current" card exactly); only the marginal
  // columns are annualised, because they make /yr claims.
  const row = (r, i, rows, marginalCols) => {
    const saving = cur.total - r.total;
    const cells = [`${r.v}`, gbp(r.total), gbp(saving)];
    if (i === 0) marginalCols.forEach(() => cells.push('—'));
    else {
      const dv = r.v - rows[i - 1].v;
      const ds = (rows[i - 1].total - r.total) * annual;   // annualised marginal saving
      for (const col of marginalCols) {
        if (col === 'value') cells.push(`${gbp(ds / dv)}/yr`);
        else cells.push(perKwh !== null ? fmtYears(paybackYears(perKwh * dv, ds, p.escPct)) : '—');
      }
    }
    const curCls = r.v === (marginalCols.length === 2 ? p.capacity : p.inverterKw) ? ' class="cur"' : '';
    return `<tr${curCls}>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  };
  const table = (id, head, rows, marginalCols) =>
    `<table id="${id}"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.map((r, i) => row(r, i, rows, marginalCols)).join('')}</tbody></table>`;
  return table('sweepCapTable',
      ['Pack kWh', 'Total £', 'Saving £', 'Marginal £/kWh·yr', 'Marginal payback'],
      caps, ['value', 'payback']) +
    table('sweepInvTable',
      ['Inverter kW', 'Total £', 'Saving £', 'Marginal £/kW·yr'],
      invs, ['value']);
}
```

Style the `.cur` row (bold or accent background) in `styles.css`, matching the existing table styling; give the sweep tables the same class the compare table uses so they inherit its look, and wrap `#sweepOut` content in the same overflow container pattern if the compare table uses one.

- [ ] **Step 4: Run the offline suites**

Run: `node test/dom.mjs && node test/units.mjs`
Expected: PASS (`sensSection`, `runSweeps`, `sweepOut` ids all cross-check).

- [ ] **Step 5: Verify in a real browser**

On http://localhost:8099: Run, then Run sweeps. Confirm: progress messages tick through ~13 runs, two tables render, the highlighted current rows' Saving matches the main "Saving vs current" card, capacity marginal £/kWh·yr declines as the pack grows (measured shape: ~£13.5/kWh·yr at 24→32, ~£11.2 at 32→40), and with battery cost 3500 the top-end marginal payback lands around 8–10 yrs.

### Task 7: Test-suite updates + full local verification

**Files:**
- Modify: `test/browser.py` (new checks)
- Run everything.

**Interfaces:**
- Consumes: ids `escPct`, `hpCost`, `gasUnitRate`, `gasScPerDay`, `runSweeps`, `sweepOut`, `sweepCapTable`, `sweepInvTable`; payback card copy from Task 4 ("prices rising", "heat pump", "gas bill removed").

- [ ] **Step 1: Add browser.py checks**

Follow the file's existing check style (selector waits, `#status:text-is('done')`, no `wait_for_function`). New checks after the existing payback checks:

```python
# --- escalated payback ---
page.fill('#escPct', '3')
page.click('#run')
page.wait_for_selector("#status:text-is('done')", timeout=180_000)
check('escalation shown on payback card', 'rising 3%/yr' in page.inner_text('#cards'))
before = page.inner_text('#cards')

# --- sensitivity sweeps ---
page.click('#runSweeps')
page.wait_for_selector('#sweepCapTable', timeout=300_000)
cap_rows = page.locator('#sweepCapTable tbody tr').count()
inv_rows = page.locator('#sweepInvTable tbody tr').count()
check('capacity sweep has 7 rows', cap_rows == 7)
check('inverter sweep has >=6 rows', inv_rows >= 6)
cur_saving = page.inner_text('#sweepCapTable tr.cur td:nth-child(3)')
check('current sweep row matches saving card', cur_saving.strip() in before)

# --- reset: escalation off reproduces the old card ---
page.fill('#escPct', '')
page.click('#run')
page.wait_for_selector("#status:text-is('done')", timeout=180_000)
check('no escalation text when blank', 'rising' not in page.inner_text('#cards'))
```

(Adapt `check(...)` to the file's actual helper name and the timeouts to its conventions — read the file before editing; the HP/gas-credit path is exercised only if a gas CSV is available to the harness, otherwise skip that block.)

- [ ] **Step 2: Run the full local chain**

```sh
cd ~/src/energy-battery-sim
node test/units.mjs
node test/dom.mjs
node test/validate.mjs     # parity — must be untouched
node test/cycle.mjs        # parity — must be untouched
node test/hold.mjs         # parity — must be untouched
node test/e2e.mjs          # live API; all `expect` figures unchanged
python3 test/browser.py http://localhost:8099
python3 test/scroll.py http://localhost:8099
```

Expected: everything green, 0 console errors, all e2e `expect` figures byte-identical (no solver change). If validate/cycle/hold report ANY diff, stop — the solver was touched by accident.

### Task 8: Deploy + verify against the live site

**Files:**
- Modify: `clusters/prod/apps/tools/energy-sim/site/` (sync copy)

- [ ] **Step 1: Sync the site copy**

Follow `clusters/prod/apps/tools/energy-sim/README.md` exactly (it carries two "don't tidy" warnings — read it first). Then `diff -rq ~/src/energy-battery-sim clusters/prod/apps/tools/energy-sim/site/` modulo the README's stated exclusions (test/, docs/, agile_battery_sim.py).

- [ ] **Step 2: Apply + roll**

```sh
kubectl apply -k clusters/prod/apps/tools
```

(configmap-hash change rolls the deployment; wait for the rollout, then hard-refresh.) Auto-mode may block compound kubectl — run commands singly.

- [ ] **Step 3: Verify the deployed site**

```sh
python3 test/browser.py https://battery.nashes.uk
```

Expected: all checks green including the new escalation/sweep checks, 0 console errors, CSP still enforced (`connect-src https://api.octopus.energy` intact — never add `includeSelectors` to the kustomization). Report to Anthony: manifests changed but **uncommitted** — commits are his (`g add clusters/prod/apps/tools` when he's ready; the tree carries many unrelated pending changes, scope deliberately).
