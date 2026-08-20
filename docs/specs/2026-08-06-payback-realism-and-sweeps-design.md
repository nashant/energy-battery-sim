# Design: payback realism (escalation + heat-pump full ledger) & sensitivity sweeps

Date: 2026-08-06. Approved by Anthony (full-ledger option; design approved same day).
Origin: gap-analysis session — capacity margins and HP economics were the two picked gaps.

## Context

The app (battery.nashes.uk, source `~/src/energy-battery-sim`) already models heat-pump
*load*: gas CSV × boiler efficiency ÷ COP added to electricity demand
(`js/data.js` `heatPumpFromGas`, `heatPumpSynthetic`), and the tariff cards compare
like-for-like with HP load on both sides (`currentTariffTotal` values HP load at the
CSV's implied unit rate). What is missing is the *economics*: heat-pump capital cost,
the gas bill a heat pump eliminates, and any notion of energy prices rising year on
year. Separately, the payback card shows only the average payback of the configured
system; measured margins (last 8 kWh of a 32 kWh pack ≈ 8-yr marginal payback vs 6-yr
warranty; 8→10 kW inverter worth only ~£28/yr) are invisible.

No solver changes anywhere in this design → `js/optimiser.js`, `js/data.js` solve path,
`test/pymodel.py` and all fixtures are untouched. Both features are app-layer.

## Feature 1 — payback: escalation % and heat-pump full ledger

### New inputs (`index.html`)

| Input | id | Section | Default | Notes |
|---|---|---|---|---|
| Energy price rise %/yr | `escPct` | cost inputs (§ with battery/inverter/install cost) | 0 | applies to both fuels; hint text "e.g. 3–5" |
| Heat pump installed cost £ | `hpCost` | 6 · Heat pump | blank (0) | shown whenever hpMode ≠ none |
| Gas unit rate p/kWh | `gasUnitRate` | 6 · Heat pump, inside `hpGasWrap` | blank | gas mode only |
| Gas standing charge p/day | `gasScPerDay` | 6 · Heat pump, inside `hpGasWrap` | blank | gas mode only |

All four wired into `params()` in `js/app.js`.

### Ledger

Definitions (all £, annualised with the existing `annual = 365 / withBat.nDays`):

- `C = systemCost(p) + (p.hpCost || 0)`
- Gas bill (gas mode only):
  `gasBill = (matchedGasKwh × gasUnitRate + gasScPerDay × nDays) / 100`,
  where `matchedGasKwh = hpInfo.gasKwh − hpInfo.unmatchedKwh` (already computed).
- Do-nothing baseline: `base = currentTariffTotal(state.usage, null, curOverride(p)).total + gasBill`
  — note **no HP add**: the counterfactual is "keep the boiler, keep the current tariff".
  This is a second call to `currentTariffTotal`; the existing HP-inclusive call still
  feeds the tariff cards and stays as-is.
- New world: `withBat.total` (already includes HP electricity when hpMode ≠ none).
- Payback saving: `S = (base − withBat.total) × annual`.

When hpMode = none (or hpCost = 0 and no gas prices entered) this reduces exactly to
today's `save × annual` — behaviour is unchanged for existing runs.

Synthetic HP mode: there is no gas data to credit, so `gasBill = 0`, hpCost still adds
to `C`, and a warning is pushed: "Synthetic heat pump: no gas bill credit — payback
counts the HP cost but not the gas saving. Use a gas CSV for the full ledger."

**Implied gas rates (addendum, 2026-08-07, Anthony's follow-up):** Octopus gas exports
carry the same "Estimated Cost Inc. Tax (p)" / "Standing Charge Inc. Tax (p)" columns as
electricity. `parseGas` now parses them (`actualP[]`/`scP[]`) and `gasImpliedRates(gas)`
derives `unitRateP = Σcost/ΣkWh` and `scPerDayP = Σsc/distinct-days` (nulls when
absent/empty). Blank manual gas inputs fall back to the implied values (`??` — manual
entry, including an explicit 0, overrides); the gasInfo line shows
"implied X p/kWh + Y p/day". The no-rate warning fires only when neither manual nor
implied exists. Real 10-day gas export at `~/Downloads/download.csv` doubles as the
browser-test fixture (implied 6.24 p/kWh + 29.95 p/day), closing the previously
untested HP/gas card-segment path.

### Escalated repay time

`paybackYears(cost, savePerYear)` gains a third parameter `escPct`:

```
e = escPct / 100
n = e > 0 ? ln(1 + cost·e / savePerYear) / ln(1 + e) : cost / savePerYear
```

(Cumulative saving through year n is S·((1+e)^n − 1)/e; solve for the crossing.
Guards unchanged: null when cost ≤ 0 or savePerYear ≤ 0.)

Applied everywhere payback is shown: the main payback card (`pbCur`), the battery-only
detail (`pbBatt`), and the per-row payback in the tariff comparison table
(`renderCompare`, app.js:367). Card detail line gains the assumptions, e.g.
`£8,500 ÷ £1,410/yr (incl. £398/yr gas) rising 3%/yr`.

### Card wording

Payback card detail enumerates the ledger when it differs from the plain division:
cost split (`battery system £3,500 + heat pump £5,000`), gas credit if any, escalation
if non-zero. The main "Saving vs current" card is NOT redefined — it stays the
like-for-like tariff-switch number; only the payback card uses the full ledger.

## Feature 2 — sensitivity sweeps

### UI

New `<details>` section "Sensitivity" after the results cards, hidden until a run
exists, with a single **Run sweeps** button and an empty container. On click:
~13 solver runs reusing `state.run.prices` and the already-built load (all current
params except the swept one), progress via the existing `status()` +
`await new Promise(r => setTimeout(r, 0))` pattern between runs. Button disabled while
running. Results cleared whenever a new main Run happens (stale sweeps must not
outlive their inputs).

### Sweeps

- **Capacity:** pack × [0.5, 0.625, 0.75, 0.875, 1, 1.125, 1.25], rounded to 0.1 kWh.
- **Inverter:** [3.6, 5, 6, 8, 10, 12] kW, plus the current value if not in the list;
  duplicates removed.

Each row = `runSim` with `{...p, capacity: v}` (or `inverterKw: v`) and
`useBattery: true`. The no-battery run and `cur` are reused, not recomputed.

### Table columns

Capacity table: pack kWh (current row marked) · total £/yr · saving vs current £/yr ·
Δ vs current setting · marginal £/kWh·yr (Δsaving ÷ Δcapacity between consecutive
rows) · marginal payback yrs = (packPricePerKwh × Δcapacity) ÷ Δsaving/yr, escalated
via the same `paybackYears` — where `packPricePerKwh = p.batteryCost / p.capacity`;
column shows — when batteryCost is unset.

Inverter table: same minus the two marginal-cost columns (no defensible £/kW price):
kW · total · saving · Δ vs current · marginal £/kW·yr.

All rows honour the active HP/floor/tariff/export-limit settings. Totals are the same
`withBat.total` measure as the main cards (energy + standing).

## Testing

- `test/units.mjs` (new, offline — keeps pure-function cases out of the live-API e2e):
  escalated `paybackYears` (e=0 equals division; known closed-form case; null guards),
  gas-ledger arithmetic (matched-kWh credit, synthetic-mode zero-credit), sweep grids.
- `test/dom.mjs`: new inputs exist and flow through `params()`; payback card wording
  with escalation + HP cost; sweep section renders; one capacity-sweep row equals a
  direct `runSim` call with that capacity.
- `test/browser.py`: deployed-site checks — set escalation/HP cost/gas rate, assert
  payback card text changes accordingly; click Run sweeps, wait for table
  (selector waits only — CSP blocks `wait_for_function` string eval), assert row count
  and that the current-setting row matches the main card's saving.
- Parity suites (`validate/cycle/hold`) must still pass untouched — no fixture
  regeneration expected; any diff there means the solver was accidentally touched.

## Out of scope (deliberate)

Battery degradation in the payback (not picked), charts for sweeps (tables first),
inverter marginal payback (no per-kW price), gas-rate auto-fetch from Octopus API,
persisting input values across sessions, discounting/NPV.

## Deployment

Same as always: sync `~/src/energy-battery-sim` → `clusters/prod/apps/tools/energy-sim/site/`
per that dir's README, `kubectl apply -k clusters/prod/apps/tools` (configmap-hash
rollout); Flux does not reconcile these manifests. Commits are Anthony's.
