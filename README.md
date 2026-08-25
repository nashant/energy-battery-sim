# Battery & tariff simulator

Works out what a home battery would have saved you on each Octopus tariff, using your own
half-hourly consumption and the real published rates.

Entirely client-side. Drop in a CSV, the page fetches rates from the public Octopus API
(which sends `access-control-allow-origin: *`) and runs the optimisation in the browser.
No data leaves the machine.

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
- Consumption is assumed unchanged by the tariff switch.

Two cycle rules: **scattered** charges in any set of slots before discharging begins;
**contiguous** charges at full power across one unbroken window. The engine defaults to
**contiguous** when the cycle mode isn't specified.

## Correctness

The optimiser is a port of `solve_day()` in `agile_battery_sim.py`. Greedy marginal pairing
is provably optimal here despite the shared per-slot discharge cap — the per-slot feasible
set is a polymatroid, so the exchange argument holds. That was checked against an exact LP
(HiGHS) over 48 stratified real days and 400 randomised synthetic days: worst gap 0.0000p.

```sh
node test/units.mjs      # pure helpers (js/data.js) — no network, no DOM
node test/replay.mjs     # offline invariants on a synthetic no-DST year
node test/causal.mjs     # JS vs Python parity on fixtures, + causality guard
node test/dom.mjs        # index.html/app.js id cross-check + FlowDiagram DOM stub
node test/e2e.mjs        # whole-year totals via the live Octopus API
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
- No solar/PV generation input.
