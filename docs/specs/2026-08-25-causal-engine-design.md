# Causal engine: replace batch windowing with real-time replay

**Status:** approved direction, pre-implementation
**Date:** 2026-08-25

## Principle

The app must behave as the real system would: at every decision point it may use
only information that would actually exist at that moment. No future prices before
their publication time, no future usage ever, no hindsight of any kind. Clicking
**Run** replays the whole CSV as massively accelerated real time, starting from
zero knowledge (empty forecast, empty battery) and learning as data arrives.

The perfect-foresight batch solver is removed as a product. "We're never going to
know the whole year up front — not the pricing, not the usage."

## What is removed

- `solveDay` as the product optimiser, `holdPass`, `cycleEdges` — batch windowing
  and both of its seam patches. Their goals survive by construction (see Planner).
- The **Discharge by** selector (end of day / Agile day / next charge cycle):
  windows no longer exist to choose between. Cycle structure becomes something the
  app reports, not an input.
- The `carried` statistic and hold-pass explanation copy.
- `test/pymodel.py` and the batch fixtures (`fixtures.json`, `cycle_fixture.json`,
  `hold_fixture.json`) with their runners (`validate.mjs`, `cycle.mjs`,
  `hold.mjs`). The JS≡Python mirror-testing discipline is retained against the new
  causal reference (below); the artifacts are rebuilt.
- Continuity with all previously published numbers. Headline results will drop
  relative to the hindsight-flattered figures; that is the point.

Not removed: all physics (net settlement, one-meter rule, inverter cap and its
charge-only/total-import variants, G100 limit + predicted-export feature, round
trip efficiency, min-charge floor, max charge price), tariff building/comparison,
payback + heat-pump ledger, sweeps panel, CSV handling, charts and hover.

## Timeline model

- Slot = half-hour settlement period. DST days have 46/50 slots.
- Tariff-day = 23:00 → 23:00 local (Agile publication unit).
- Price publication: the next tariff-day's import and export prices become known
  at a fixed simulated time `PUBLISH_AT = 16:00` daily. (Real Agile is sometimes
  late; the constant is config, and the live HA planner triggers on actual
  arrival.)
- At replay start (first CSV timestamp), the current tariff-day's prices are
  already known (published the previous afternoon); nothing further is.

## Planner

A pure function, no internal state:

```
plan = solveHorizon(soc0, prices[t0..H], forecastLoad[t0..H], cfg)
```

- **Inputs:** current battery SOC, published prices to the horizon, forecast load
  to the horizon, existing physics config. Nothing else.
- **Horizon H:** 23:00 at the end of the last published tariff-day. Before the
  16:00 publication that is 23:00 today; after it, 23:00 tomorrow.
- **Re-plan triggers:**
  1. Price publication (mandatory). The new plan covers the window starting at
     the first half-hour boundary ≥ now + 5 minutes; the in-flight slot finishes
     on the old plan.
  2. Optional: remaining-horizon forecast deviation > threshold (default **off**;
     config `replanDeviationPct`). To be enabled only if the replay harness shows
     it earns its keep.
- **Plan form:** per-slot SOC targets / actions (charge-to, hold, discharge,
  export), not open-loop kWh — execution against actual load self-corrects
  instead of compounding drift between re-plans.
- **Energy-balance rule, horizon form:** only charge energy that places
  profitably (to forecast load or export) before H. This preserves the original
  rule's purpose — no charging through negative prices to let energy evaporate,
  no speculative carry past known prices — without windows. Cross-midnight
  "hold" behaviour emerges naturally whenever H spans the boundary.
- Charge sizing values house displacement at forecast load × import price and
  export at export price under the G100/inverter caps, exactly as the batch
  solver valued them with hindsight load.

## Forecaster

Two layers, both cheap, all parameters config:

1. **Baseline profile** — 48 per-slot values × {weekday, weekend}, EWMA-updated
   once per completed day: `profile[s] ← α·actual[s] + (1−α)·profile[s]`,
   default `α = 0.15`.
2. **Intra-day regime ratio** — after each settled slot,
   `r = Σactual_today / Σprofile_so_far`; remaining-horizon slots scaled by
   `1 + λ(r − 1)` with λ ramping over the day (early blips must not rescale the
   evening). The ratio is dampened further (or zeroed) across the day boundary:
   tomorrow's charge sizing is Layer-1 business.

**Cold start:** forecast is zero until the first day completes (day-1 planning is
therefore export-arbitrage-sized only); the first completed day seeds the profile
directly, EWMA thereafter. The UI marks the warm-up region (first ~2 weeks) on
the results.

The forecast is *sampled at plan time*; between plans it updates silently (and
feeds trigger 2 if enabled).

Forecaster choice and parameters are empirical questions: the replay harness
scores candidates in £/yr against an actual-load oracle run, not RMSE. If naive
beats clever, ship naive.

## Replay loop (what Run does)

```
state: soc = 0, profile = empty, todaySums, plan
plan = solveHorizon(0, prices[t0 .. 23:00 today], zeros, cfg)   # replay start
for each slot i in CSV order:
    if sim-time passed 16:00 since last check: publish prices(D+1); replan from
        first boundary ≥ now+5m
    execute plan[i] against ACTUAL load[i]:
        charge  = clamp(plan charge-to target, slot physics)
        discharge→load = min(actual load, planned discharge, slotOut)
        export  = planned export, bounded by G100/inverter, net settlement
        soc, slot cost, per-day accounting as today
    settle slot: update todaySums, (optionally trigger 2)
    at day completion: EWMA update, reset todaySums
```

Costing, per-day aggregation, SOC violation checks, and the `slots[]` shape feed
the existing UI unchanged wherever possible. Sweeps rerun the full replay per
configuration with an identical cold start, so comparisons stay like-for-like.

**Performance budget:** ~2 plans/day ≈ 730 `solveHorizon` calls/year (plus
deviation triggers if enabled), each over ≤ 62 slots. Target: Run in low single
seconds; sweeps ≈ 30× that, streamed with progress as today.

## Implementation & validation

- **Python reference:** `test/causal_model.py` — planner + forecaster + replay
  loop, the new ground truth (and, verbatim, the future HA integration's brain).
- **JS engine:** `js/causal.js` (planner + forecaster) consumed by a rewritten
  `runSim` replay loop in `data.js`. `optimiser.js` internals are reused where
  they fit (bucket/valueFor machinery) but `solveDay`'s window API goes.
- **Fixtures:** generated by the Python reference on synthetic year(s) plus real
  CSV samples: per-slot plans, SOC trajectory, totals. `test/causal.mjs` asserts
  JS ≡ Python exactly (the `validate.mjs` discipline, re-based).
- **Causality guard test:** mutate all prices/loads *after* time t in a fixture;
  assert every decision at ≤ t is bit-identical. This mechanically proves no
  future leakage, forever.
- Unit tests for forecaster arithmetic (EWMA, ratio damping, DST days, weekday
  split) in `units.mjs`.

## UI changes

- Remove: Discharge-by select, hold/window copy, `carried` stat.
- Add: warm-up marker on results; forecast-vs-actual visible in the day view
  (planned SOC line vs realised SOC on the existing chart).
- README model section rewritten around the causal loop.

## Out of scope (recorded, not planned)

- Weather/temperature-conditioned forecasting (matters for the heat-pump mode
  later).
- Historical Agile publication-time data (fixed 16:00 assumed in replay).
- Terminal-SOC option value beyond the horizon-truncated energy-balance rule.
