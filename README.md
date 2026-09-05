# Battery & tariff simulator

Works out what a home battery would have saved you on each Octopus tariff, using your own
half-hourly consumption and the real published rates.

Entirely client-side. Drop in a CSV, the page fetches rates from the public Octopus API
(which sends `access-control-allow-origin: *`) and runs the optimisation in the browser.
No data leaves the machine. Your CSVs and every input on the panel are kept in the
browser's own storage (saved when you press Run or Compare) so a return visit starts where
you left off; the clear button forgets them.

## Run

```sh
python3 -m http.server 8099    # from this directory
# then open http://localhost:8099
```

Any static file server works. It must be served over HTTP, not opened as `file://`, because
the code uses ES modules.

## Model

- Capacity is the pack's size in kWh; the **min charge** floor (default 10%) walls off
  the bottom slice, so a 32 kWh pack cycles within 28.8 kWh and displayed state of charge
  never drops below the floor. Round-trip loss applies on charge, so storing a full
  28.8 kWh imports 28.8/0.9 = 32 kWh. Set the floor to 0 to treat capacity as fully
  usable.
- Inverter power caps charge and discharge per half-hour slot. Discharge to load and to
  export share that cap. A separate G100 export limit can cap export below inverter size.
- By default the inverter limit applies to battery charging only, so grid import during a
  charge slot is house load *plus* battery charge. "Cap total grid import" switches that.
- **Causal replay.** Run replays your CSV as accelerated real time. The planner
  only ever sees: the battery's current charge, prices that have been published
  (Agile day-ahead lands at 16:00), and a load *forecast* built from days it has
  already lived through. It starts knowing nothing — the first two weeks are a
  cold-start warm-up while the forecast learns your house.
- **Planning.** At the start of every half hour the plan is recomputed from the
  battery's current charge and the latest forecast, out to the end of the
  published prices (23:00 today until the 16:00 publication, then 23:00
  tomorrow): charge in the cheapest slots, hold, serve the house and export
  through the peaks — sized against forecast load, never actual future load.
  Only the first step of each plan is ever executed, so forecast error corrects
  within the half hour instead of compounding until the next day. Energy is only
  charged if it can be placed profitably before the end of the known-price
  horizon.
- **Execution.** Each half hour the plan meets reality: discharge covers the
  slot's actual load first (a meter settles one direction per half hour), any
  planned remainder exports under the G100 cap, and the forecast learns from the
  actual. Between planned actions the inverter load-follows in self-use mode —
  covering actual load the forecast missed — but only when the avoided import
  price beats the plan's marginal refill cost, so the pack is never drained into
  slots cheaper than refilling it. The day chart's shaded area is the actual state
  of charge; hovering a slot shows what the plan expected it to be, with the prices
  and the house load (drawn as a line on the solar scale).
- Numbers from this engine are lower than the old perfect-foresight build's —
  deliberately. Those assumed a year of hindsight; these are achievable.
- Consumption is assumed unchanged by the tariff switch.
- **Cycle wear** (optional). Battery cost ÷ (cycle life × usable kWh) gives a wear charge in
  p per kWh stored; it is added once, on the charge side, so pass-2 spreads, the hold floors
  and the load-following gate all see it, and trades thinner than the wear are skipped.
  Reported separately as £/yr and as cycles per year against the quoted life; it is not
  subtracted from the energy saving or counted again in payback, which already uses the
  full battery cost.
- Export choices are limited to the pairings Octopus permits (Smart Tariffs T&Cs: Flux is
  import+export only, §2.7.1; Go and Cosy pair only with Outgoing SEG, Outgoing Octopus or
  Agile Outgoing, §2.1.2/§2.6.2). Compare runs every permitted pairing that has a published
  product.
- **Solar.** Any number of arrays (postcode, bearing, tilt, kWp, inverter, losses, AC or
  DC coupling, cost). Actual generation is the UK Met Office 2 km model via Open-Meteo at
  15-minute resolution; the plan sees only the day-ahead forecast that existed at plan time
  (day-1 for slots ≤ 24 h ahead, else day-2), corrected by today's actual-to-forecast ratio.
  PV serves the house first; surplus is stored when a later slot beats the export price,
  otherwise exported under the G100 cap or spilled. A surplus slot never imports. DC arrays
  share the hybrid inverter's output with discharge: an overflow comes off battery export,
  then off discharge to the house (PV serves that load instead and the pack keeps the
  energy), and only then clips PV. Each array has an **include in run** toggle, so it can
  be left out of a run (its cost too) without deleting it; the setting is remembered.

### Planner options

Each defaults to the shipped behaviour; the same names are `params` fields for `runSim`,
`--flags` for `test/score.mjs`, and selects under **Planner options** on the page.

- **holdFor** — when energy already in the pack is kept rather than spent:
  `anyCheaperRefill` (a cheaper chargeable slot exists anywhere in the plan; the shipped
  rule), `laterCheaperRefill` (only if that slot comes *after* the one being valued, since
  a refill cannot replace energy spent before it), or `never`.
- **packEnergyWorth** — how existing energy is valued when spent: `displacedPrice` (the
  import price it avoids; shipped) or `refillCost` (load that a later refill can serve is
  worth no more than that refill, so existing energy goes to export and to load before the
  refill instead of to tomorrow's load). Under `refillCost` a spend may only take the
  energy surplus — pack energy plus room at cheaper refill slots, less the demand worth
  more than the spend — and spending inside a refill slot forfeits that slot's room, so
  the pack is never sold off in a cheap window that then has too few slots left to refill it.
- **priceHorizon** — `published` (tomorrow's prices arrive at 16:00; shipped) or
  `knownSchedule48h` (plan 48 h ahead on the import schedule, with export beyond the
  published boundary taken from yesterday's same slot). Honest only for fixed time-of-use
  tariffs such as Go, Cosy and Flux; on Agile it is hindsight.
- **replanEvery** — half-hours between re-plans (1; publication and plan expiry always
  re-plan).

Scores on a real year are in `docs/plans/2026-09-04-planner-scoring.md`.

Two cycle rules: **scattered** charges in any set of slots before discharging begins;
**contiguous** charges at full power across a single window (slots already committed
to discharge are skipped inside it). The engine defaults to
**contiguous** when the cycle mode isn't specified.

## Correctness

The optimiser is `solveHorizon` in `js/causal.js`: a greedy planner over the published
price horizon. It first spends whatever is already in the pack on the best-valued slots
(holding anything worth less than the cheapest refill in the horizon),
then books cheap-charge → dear-discharge pairs in order of spread, each one checked
against the SOC trajectory so no plan can overfill or overdraw the pack. It is a heuristic
by design, not a claim of optimality — the constraint that matters is causality, not the
last fraction of a penny: no plan may use a price before its publication time or a load
before it happens. Two things hold that honest. The planner is mirrored line-for-line in
Python and the two must agree bit-exactly on committed fixtures, so neither language can
drift silently. And a causality guard replaces every price and load after a cut point with
garbage, then asserts that every decision taken before that data would have been published
is bit-identical — mechanically proving no hindsight leaks in. Physics invariants are asserted
separately: the one-meter rule, SOC bounds and the max-charge-price filter at both the
planner and whole-replay level; the inverter cap at the planner level.

```sh
node test/units.mjs      # pure helpers (js/data.js) — no network, no DOM
node test/replay.mjs     # offline invariants: synthetic year + 46/50-slot DST days
node test/causal.mjs     # JS vs Python parity on fixtures, + causality guard
node test/dom.mjs        # index.html/app.js id cross-check + FlowDiagram DOM stub
node test/e2e.mjs        # whole-year totals via the live Octopus API
node test/pv_fetch.mjs   # PV series builder used by the scorer, against Open-Meteo
```

`test/score.mjs` is the offline £/yr scorer: it replays a real usage CSV against a real
price CSV (the Octopus "Period from, Period to, Import, Export" download) with the
forecaster's parameters overridable, and prints saving per configuration. List-valued flags
score their Cartesian product; `--from YYYY-MM-DD` counts only days from that date, so the
cold start is lived through but not scored.

```sh
node test/score.mjs --usage usage.csv --prices prices-agile-J.csv                 # 32 kWh / 10 kW, contiguous, no export
node test/score.mjs ... --cap 32,10 --inv 10,5 --cycle contiguous,scattered --export 0,1
node test/score.mjs ... --alpha 0.15,0.3 --lambda 0,0.75,1 --ramp 8,16 --from 2025-08-18
node test/score.mjs ... --holdFor anyCheaperRefill,laterCheaperRefill --packEnergyWorth displacedPrice,refillCost
node test/score.mjs ... --cycles 4000,8000 --cost 3500                  # cycle wear; blank cycles = none
node test/score.mjs ... --pv pv.json                                    # PV series from `node test/pv_fetch.mjs`
```

The Python reference for the causal engine is `test/causal_model.py` — a line-for-line
transcription of `js/optimiser.js` (primitives), `js/causal.js` (Forecaster +
solveHorizon) and the replay loop in `js/data.js`. `test/causal.mjs` checks JS-vs-Python
parity against fixtures in `test/causal_fixture.json`, regenerated deterministically by
`test/gen_causal_fixtures.py`. Any edit to `js/causal.js` or the replay loop must be
mirrored in `test/causal_model.py`, with fixtures regenerated from it.

The standalone CLI (`agile_battery_sim.py`) predates the causal engine's forecaster and
replay loop, so its totals assume perfect foresight and don't match the app.

## Heat pump

Either synthetic (annual kWh spread over a documented monthly curve and a flat-ish diurnal
shape for a weather-compensated unit) or derived from a **gas CSV**, which is much better:
gas kWh → useful heat (× boiler efficiency) → electricity (÷ COP), on the real metered
shape. The annual total drives the result far more than the shape, because the battery
time-shifts the load anyway.

## Known limits

- The autumn DST repeated hour is handled correctly — rates are keyed by UTC instant, so
  both 01:00–02:00 hours get their own price. (The CSV-based CLI cannot express this and
  gives them the same price, worth under 1p/yr.)
- G100 limits **net** export at the connection point; this caps the battery's **gross**
  export. They diverge only in rare negative-price slots where the optimiser exports while
  leaving residual load on the grid. Capping gross is the conservative direction.
- Prime Outgoing launched 2026-06-23, so historical slots fall back to a flat rate.
- PV is modelled from a 2 km weather model, not a site measurement; shading is not
  modelled beyond the losses percentage.
