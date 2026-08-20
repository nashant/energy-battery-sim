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
- **One cycle per discharge window**: within a window all charging strictly precedes all
  discharging, and every kWh charged is either discharged inside the window or carried
  forward by the hold pass (below). The energy-balance rule is load bearing — without it
  the optimiser charges through negative-price slots purely to collect the payment and
  lets the energy evaporate, which is worth real money and is not physical.
- **Discharge by** picks the window: *end of day* (local midnight), *end of Agile day*
  (23:00), or *next charge cycle*. The last redefines the window as charge-start to
  charge-start via a fixed point — solve on calendar cuts, re-cut each window at its first
  charging slot, repeat until stable (~3 iterations). Cost accounting itself is
  window-independent (verified to 4 dp); only the cycle structure moves.
- **Hold pass**: at each window boundary, energy the outgoing window would dump into its
  cheapest discharge slots is carried forward instead whenever the next window values it
  higher — serving load that falls before its discharge phase (bridging) or displacing
  its most expensive refill kWh. Kills the sell-low-rebuy-high dumps (~848 kWh/yr on
  Agile+Outgoing 10 kW) and is worth ~£37/yr on the end-of-day boundary, ~£17/yr on the
  cycle boundary (they land within £3 of each other once holding is in place).
- **Net settlement**: a single meter cannot record import and export in the same half
  hour, so discharge covers the slot's own load before anything exports — even when the
  export price momentarily exceeds import. Export-while-importing can never appear.
- Perfect foresight of each day's prices. Realistic on Agile, which publishes day-ahead.
- Consumption is assumed unchanged by the tariff switch.

Two cycle rules: **scattered** charges in any set of slots before discharging begins;
**contiguous** charges at full power across one unbroken window. Scattered is always at
least as good on cost, since its feasible set contains every contiguous plan. The
defaults are **contiguous + next charge cycle** — one unbroken fill per cycle is the
gentler, more realistic dispatch; on the reference year it costs ~£10/yr over scattered
(£673.68 vs £663.52 at 10 kW, Agile+Outgoing, region J).

## Correctness

The optimiser is a port of `solve_day()` in `agile_battery_sim.py`. Greedy marginal pairing
is provably optimal here despite the shared per-slot discharge cap — the per-slot feasible
set is a polymatroid, so the exchange argument holds. That was checked against an exact LP
(HiGHS) over 48 stratified real days and 400 randomised synthetic days: worst gap 0.0000p.

```sh
node test/validate.mjs   # JS vs Python, per day, on real fixtures
node test/cycle.mjs      # 'next charge cycle' group structure vs Python, exact
node test/hold.mjs       # hold pass vs Python: identical held-energy sequence & totals
node test/e2e.mjs        # whole-year totals via live API, vs Python-mirror figures
```

`validate.mjs` matches Python exactly (0.00e+0 worst-day difference across 8 configs,
including import-cap, G100 and max-charge-price paths).

The Python reference for the current model is `test/pymodel.py` (net-settlement buckets +
rebalance + hold pass layered over the CLI's solver). The standalone CLI
(`agile_battery_sim.py`) predates the hold pass and net settlement, so its totals now run
£20–70/yr higher than the app's; `test/e2e.mjs` records the pre-hold figures alongside
the current expectations. The remaining CLI-vs-app pence differences on banded tariffs
(Go, Cosy) come from `fetch-tariff.py` writing prices at 2 decimal places while the app
uses full API precision.

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
