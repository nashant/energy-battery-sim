# Planner scoring on real data — 2026-09-04

Offline £/yr scores from `test/score.mjs` on the household's real year
(`usage-electric.csv`, 2025-08-04 → 2026-08-03, 6,007 kWh; Agile region J prices from the
Octopus price CSV). Saving = no-battery energy cost − with-battery energy cost, standing
charge excluded, whole year including the 14-day cold start. Engine = working tree at
c2b0a75 plus the uncommitted pass-1 hold floor and export cap (both mirrored, parity 0.0).
Nothing below has been adopted; candidates were scored behind temporary flags that were
removed afterwards.

## Question that prompted this

"Can the algorithm adjust battery output during the day from usage so far vs projected?"
It already does: `Forecaster.ratio()` (`js/causal.js:27-32`) scales today's remaining
forecast by actual/expected-so-far, damped by λ=0.75 and ramped in over 16 slots; the plan
is recomputed every half hour (`js/data.js:272-282`); load-following covers what the plan
under-sized (`js/data.js:253-260`). On this data the mechanism is worth about £3.6/yr
(λ=0 → £398.98 vs λ=0.75 → £402.55) because the morning barely predicts the evening
(corr 0.08 at 08:00, 0.2-0.26 after noon).

## Baseline and perfect-foresight oracle (£/yr saving)

Oracle = same planner fed the actual load instead of the forecast; it is the ceiling for
forecast improvements only, not for solver improvements.

| cap/inv | cycle | export | shipped | oracle | forecast gap |
|---|---|---|---|---|---|
| 32/10 | contiguous | no  | 402.55 | 414.18 | 11.6 |
| 32/10 | contiguous | yes | 634.77 | 639.70 | 4.9 |
| 32/10 | scattered  | no  | 370.46 | 383.67 | 13.2 |
| 32/10 | scattered  | yes | 614.53 | 619.09 | 4.6 |
| 10/10 | contiguous | no  | 362.21 | 372.34 | 10.1 |
| 10/10 | contiguous | yes | 382.08 | 388.39 | 6.3 |
| 10/10 | scattered  | no  | 341.40 | 353.45 | 12.1 |
| 10/10 | scattered  | yes | 360.26 | 367.41 | 7.2 |
| 32/5  | contiguous | no/yes | 386.24 / 581.21 | | |
| 10/5  | contiguous | no/yes | 353.19 / 377.51 | | |

Forecast error costs £5-13/yr. Scattered loses £20-32/yr to contiguous even with perfect
load knowledge, so that loss is in the solver.

## Candidates (32/10 contiguous no-export unless stated; Δ vs shipped)

| # | Candidate | 32/10 no-exp | 32/10 exp | 10/10 no-exp | 10/10 exp | Verdict |
|---|---|---|---|---|---|---|
| 1a | λ=0 (no intra-day ratio) | 398.98 (−3.6) | | | | keep ratio |
| 1b | λ=1, ramp 16 / ramp 8 | 402.23 / 402.41 | | | | noise |
| 1c | ramp 8, λ=0.75 | 402.96 (+0.4) | | | | noise |
| 1d | α=0.3 (λ 0.75/1, ramp 16) | 401.93 / 402.79 | | | | noise; keep 0.15 |
| 2 | recency-weighted ratio, EWMA half-life 4 slots, λ 0.75 | 404.00 (+1.5) | 635.24 (+0.5) | 363.61 (+1.4) | 383.30 (+1.2) | marginal |
| 2 | half-life 6, λ 0.75 | 404.32 (+1.8) | 634.99 (+0.2) | 363.30 (+1.1) | 382.41 (+0.3) | marginal |
| 2 | half-life 4/6, λ 1 | 404.06 / 403.56 | 635.12 / 634.95 | 361.32 / 361.40 | 383.23 / 382.88 | no better |
| 3 | lag-1 residual carry 0.46×, 1/2/4 slots | 402.55 / 402.33 / 402.62 | 635.75 / 635.86 / 635.79 | 362.20 / 362.34 / 362.57 | 382.21 / 382.27 / 382.32 | drop |
| 4 | contiguous fill-to-margin (cheapest-first, stop at value ≤ cost) | **410.71 (+8.2)** | **642.31 (+7.5)** | **371.58 (+9.4)** | **389.72 (+7.6)** | adopt candidate |
| 5 | unified price floor: load-follow gated on plan's cheapest refill, not dearest booked | **409.70 (+7.2)** | **640.62 (+5.9)** | **367.68 (+5.5)** | **388.54 (+6.5)** | adopt candidate |
| 5 | same, scattered | 379.84 (+9.4) | 618.62 (+4.1) | 349.20 (+7.8) | 366.03 (+5.8) | |
| 4+5 | combined | **417.09 (+14.5)** | **646.63 (+11.9)** | **376.81 (+14.6)** | **394.48 (+12.4)** | beats the shipped-planner oracle |
| 4+5+2 | + EWMA ratio hl 6 | 417.09 | 647.06 | 376.86 | 395.08 | ratio adds ≤ £0.6 on top |

Candidate 4 tripled run time (8 s → 30 s per year) as scored; the crossing search must be
memoised per window start before it is adoptable in the browser.

## Exact-solver diagnostic (candidate 6)

DP over SOC on a 0.05 kWh grid, loads rounded onto the same grid for all solvers, on the
363 real 16:00-publication horizons with actual load and the replay's SOC at 16:00.
Objective for all three: Σ(load served × import + export × export price − charge × import)
+ cheapest-refill value of terminal SOC — the planner's own valuation. No horizon has DP
below greedy, so it is a true upper bound.

| cap/inv export | scattered greedy | contiguous greedy | DP optimum | DP > contiguous |
|---|---|---|---|---|
| 32/10 no  | £958.08 | £944.95 | £1062.75 (+12.5%) | 359/363 |
| 32/10 yes | £2164.20 | £2129.61 | £2366.13 (+11.1%) | 342/363 |
| 10/5 no   | £852.13 | £837.80 | £945.63 (+12.9%) | 363/363 |

Two conclusions. First, on paper the scattered greedy plan is *better* than contiguous
(by 1.4-1.7%), yet in the replay scattered loses 3-8%: the loss comes from executing only
the first step of a plan that is remade every slot, not from the plan itself. The likely
mechanism is deferral churn (each replan finds a marginally cheaper later slot and never
charges) — not verified here. Second, an exact solver would raise plan value ~12% over
greedy; how much of that survives receding-horizon execution and forecast error is
unknown and is the next thing worth measuring (the DP above costs ~7M ops per horizon,
so it would need a coarser grid or a bang-bang action set to run per slot in the browser).

## Recommendation

1. Adopt 4+5 (fill-to-margin + unified floor) after memoising the crossing search and
   mirroring both in `test/causal_model.py`; regenerate fixtures. Expected +£12-15/yr on
   this household at every size tested.
2. Leave the intra-day ratio as is; the EWMA variant is within noise.
3. Drop lag-1 carry and the α/λ/ramp retune.
4. Investigate the scattered execution loss with the harness before offering scattered as
   an option users should pick; and prototype an exact per-horizon solver against the DP
   bound.

## Go import + Agile Outgoing export: why the pack never exported (2026-09-04, later)

Screenshots of two consecutive Go days showed evening export at ~15-25p, overnight charge
at ~8.5p (9.3p pack-side) and zero export. Two agents traced it independently (synthetic
reproduction and real-data ablation); the cause is pass 1's valuation of energy already in
the pack, not any export rule:

1. Before 16:00 the horizon ends at 23:00 today and contains no cheap slot, so the hold
   floor (cheapest chargeable price in the horizon / eff) is 29.37/0.9 = 32.6p, above every
   load and export bucket: pass 1 holds everything and only load-following spends it.
2. After 16:00 the horizon includes tomorrow; tomorrow's 29p load slots outrank today's
   15-25p export slots in the value-sorted bucket list, so the pack is reserved for load
   that tonight's 9.3p refill could serve. Pass 2 cannot pair tonight's charge with today's
   export because the charge must precede the discharge.

Shipped engine on the real year: £1,132/yr saving, 486 kWh exported on 138 days. Load-
adjusted ceiling for this pair ≈ £525/yr of export margin.

### Planner options (now flags; defaults = shipped) — £/yr saving, contiguous

| holdFor / packEnergyWorth | Go+Outgoing 32/10 | Agile+Outgoing 32/10 | Agile no-exp 32/10 | Go 10/5 | Agile+Outgoing 10/5 | Agile no-exp 10/5 |
|---|---|---|---|---|---|---|
| anyCheaperRefill / displacedPrice (shipped) | 1132 (486 kWh exp) | 635 | 403 | 684 | 378 | 353 |
| anyCheaperRefill / refillCost | **1356** (2,632) | **657** | **474** | **685** | **391** | **375** |
| laterCheaperRefill / displacedPrice | 1291 (5,349) | 641 | 462 | 586 | 377 | 368 |
| laterCheaperRefill / refillCost | 1283 (5,438) | 651 | 474 | 581 | 384 | 375 |
| never / displacedPrice | 1138 | | | 684 | | |
| never / refillCost | 1361 (2,705) | | | 685 | | |

- `packEnergyWorth: refillCost` (load a later refill can serve is valued at that refill's
  cost, so existing energy goes to export and to load before the refill) never loses on
  any tariff or size tested: +£224 on Go with export, +£22 to +£71 on Agile. An earlier
  variant that also capped *export* buckets lost £60-75 because existing energy was then
  never planned for export; the shipped flag caps load only.
- `holdFor: laterCheaperRefill` helps 32 kWh packs (+£159 Go, +£59 Agile no-export) but
  costs the 10 kWh / 5 kW pack ~£100 on Go: it exports energy the house needs after the
  23:00 horizon end. Off by default.
- `priceHorizon: knownSchedule48h` (48-slot rolling horizon on the Go schedule) was
  neutral at 48 slots and harmful at 96 in the earlier sweep (contiguous £694, scattered
  £1,086 vs £1,132), likely because contiguous books one charge window per plan and keeps
  choosing tomorrow night's. Off by default; kept as a flag for further work.
- `replanEvery` 2 / 4 / 48: 1132 / 1131 / 1124 on Go, 634 / 632 / 583 on Agile with export.
  Every slot stays the default.

Recommendation: consider making `packEnergyWorth: refillCost` the default after a second
household's data confirms it; the other flags stay opt-in.
