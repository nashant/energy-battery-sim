# Solar arrays in the causal engine — design

Date: 2026-09-04. Status: draft for review.

## Goal

Model any number of PV arrays alongside the battery, with the replay behaving as a real
controller would: each half hour it executes against what the sun actually did, learns from
it, and re-plans on the PV forecast that was genuinely available at that moment. Inputs are
a postcode and, per array, orientation, tilt, size, inverter, losses, coupling and cost.
Irradiance comes from a free, browser-callable API with at least half-hourly granularity.

## Non-goals

Shading, soiling, temperature derating beyond a flat loss factor, panel degradation,
battery-to-PV DC bus modelling beyond a shared power cap, and any change to the greedy
planner's search itself.

## Data sources (all verified browser-callable, no key, in this session)

| Purpose | Source | Notes |
|---|---|---|
| Postcode → lat/lon | `https://api.postcodes.io/postcodes/{pc}` | CORS ok, ~100 ms |
| Actual irradiance | `https://historical-forecast-api.open-meteo.com/v1/forecast` `minutely_15=global_tilted_irradiance` with `tilt`, `azimuth`, `models=best_match` | UK Met Office 2 km stitched short-range runs; 15-min values (interpolated in the UK) summed to half hours. From 2022. |
| Day-ahead forecast | `https://previous-runs-api.open-meteo.com/v1/forecast` `hourly=global_tilted_irradiance_previous_day1,global_tilted_irradiance_previous_day2` with `tilt`, `azimuth` | Value forecast 24 h (48 h) before valid time. From Jan 2024. Hourly, spread evenly over the two half hours. |

Both series are **all-sky** irradiance: the model's cloud field is already applied, so
they carry real weather (the 21% day-ahead error below is almost entirely cloud error).
Open-Meteo's separate cloud-cover percentages are therefore not used — feeding them in as
well would count clouds twice. What remains unmodelled is the gap between a 2 km grid cell
and this particular wall (local shading, mist, dirt).

Open-Meteo azimuth convention: 0 = south, −90 = east, +90 = west (verified by peak-hour
check). The UI takes a compass bearing and converts: `az = ((bearing − 180 + 540) % 360) − 180`.

Measured skill on the user's south wall, Aug 2025–Aug 2026: day-ahead vs actual daily MAE
0.47 kWh/m² on a 2.26 mean. ERA5 reanalysis over-reads the UK model by 24%; it is not used.

Non-commercial limits: 10,000 calls/day; one array costs three calls (actual, forecast,
postcode once). Responses are cached in the existing IndexedDB store under
`pv:{kind}|{lat}|{lon}|{tilt}|{az}|{start}|{end}` so re-runs are free.

## Array model

Per array: `name`, `bearing` (compass °), `tilt` (° from horizontal), `kwp`, `inverterKw`
(blank = no clip), `lossPct` (default 14, PVGIS convention), `coupling` (`ac` | `dc`), `cost` £.

Per slot AC-side energy for an AC-coupled array:
`kWh = GTI_Wm2 × 0.5 / 1000 × kwp × (1 − lossPct/100)`, clipped to `inverterKw × 0.5`.
For a DC-coupled array the same formula gives DC energy into the hybrid inverter; clipping
is by the battery inverter inside the engine (below).

Arrays are summed into four series the engine receives, each `T` long, kWh per slot:
`pv.ac`, `pv.dc` (actual) and `pv.acF1`, `pv.acF2`, `pv.dcF1`, `pv.dcF2` (day-1 and day-2
forecasts). No arrays → all zeros and the engine is bit-identical to today (parity fixtures
unchanged).

## Engine semantics

Notation per slot t: `L` house load, `P = ac + dc` PV, `net = L − P`. All kWh per half hour,
`eff` round-trip applied on charge as today.

### What the plan sees

`solveHorizon(soc0, imp, exp, loadF, pvF, cfg, mode, allowExport)` gains `pvF = {ac, dc}`
forecast series for the horizon. Internally it works on `netF = loadF − (ac + dc)`:

- **Deficit slots** (`netF ≥ 0`) are exactly today's slots with `loadF := netF`: load
  buckets valued at import, export buckets at export price, grid-charge candidates at
  `imp/eff (+ wear)`.
- **Surplus slots** (`netF < 0`, surplus `S = −netF`) add a **PV charge candidate**: room
  `min(S, chargeRoom)` pack-side `× eff`, cost per pack-kWh `max(0, exp[t]) / eff (+ wear)`
  — the export revenue forgone, so surplus is stored only when a later bucket beats the
  export price. Surplus not stored is exported (bounded by the export cap; excess spilled
  at 0). A surplus slot is an export slot, so **grid-charge candidates are excluded there**
  (one-meter rule) and it has no load bucket. If `allowExport` is false the PV candidate's
  cost is 0 (the alternative is spilling).
- Contiguous mode: PV candidates are available in every plan regardless of the single
  grid-charge window; they are booked in pass 2 before the window search, best spread
  first, since free-ish energy should never be displaced by a paid window.
- Pass 1 hold floor and `packEnergyWorth` use the cheapest *grid or PV* refill cost, so a
  sunny tomorrow lowers the value of holding energy tonight.

### What execution does (the "recalculate the previous half hour" step)

At slot i, with actual `L`, `ac`, `dc`:

1. `netA = L − ac − dc`.
2. Planned grid charge `cin` executes only if `netA ≥ 0` (a surplus slot cannot import);
   planned PV charge `pvc` executes as `min(planned, surplus, room)`; any surplus above that
   is exported up to `exportCap` (the connection's G100 limit, taken by PV before battery
   export), the rest spilled.
3. Discharge covers the actual deficit first (`dl = min(netA⁺, q)`), then booked export.
4. Load-following covers remaining deficit under the same price gate as today.
5. Flows recorded per slot: `pvToHouse = min(L, P)`, `pvToBattery`, `pvExport`, `pvSpill`,
   plus today's `cin, dl, dx`.

DC coupling: `dc` energy first charges the pack, bounded by the battery charge rate (the
inverter's `slotIn` is used as that rate), or serves load/export through the inverter's AC
output, which it **shares with discharge**: `dcOut + dl + dx ≤ slotOut`. Contention there
comes off battery export first, then off discharge to the house (the inverter's AC output
is the same either way, so the house is served identically while PV passes through in
place of stored energy and the pack keeps it — a held kWh keeps its value; clipped PV is
lost), and only DC energy above all three bounds is spilled (the hybrid inverter clips it). AC coupling: `ac` is
independent of the battery inverter; PV → battery uses the inverter's charge path (bounded
by `slotIn`) and total export `pvExport + dx ≤ exportCap` — the connection limit, which is
unbounded when none is entered, while `dx ≤ exportSlot` remains the battery's own bound.

### Forecaster

Load forecasting is unchanged and still learns actual `L`, not net. PV forecasting is a
separate small class, `PvForecaster`:

- Base for slot t at plan time τ: `F1[t]` if `t − 48 slots ≤ τ` (the day-1 forecast for t
  was issued 24 h before t, so it exists at τ), else `F2[t]`. This is what makes the 16:00
  plan honest for tomorrow's evening, whose day-1 forecast is issued after 16:00 today. The
  horizon never exceeds 31 h, so `F2` always covers it; slots with a null value in either
  series fall back to the other, then to 0.
- Intra-day ratio, as for load: `r = Σactual_today / Σforecast_today` over settled daylight
  slots, damped `1 + λ(r − 1)`, ramped over the first 8 daylight slots, applied to today's
  remaining slots only. Same `FORECAST_DEFAULTS` λ and ramp.
- `settle(slot, actual)` after execution; `completeDay` resets.

### Causality

The guard in `test/causal.mjs` garbles, at/after the cut: actual PV, `F1` for slots
≥ cut + 48 (issued at/after the cut), `F2` for slots ≥ cut + 96. Decisions before the
reveal must be unchanged; decisions after must change. `F1` values for slots in
[cut, cut + 48) were issued before the cut and are legitimately readable, like the known
import schedule in `knownSchedule48h`.

## Accounting and results

`runSim` returns, in addition to today's fields: `pvKwh`, `pvToHouse`, `pvToBattery`,
`pvExport`, `pvSpill`, `pvCost`. Slot costs already follow from grid import and export, so
`energy` needs no new terms. `perDay` gains `pv` kWh.

- "Tariff, no battery" becomes PV-only (house uses PV directly, surplus exported) when
  arrays exist, so "Saving vs current" and "of it from the battery" stay meaningful.
- New card **Solar**: generated kWh, % used directly, % stored, % exported, % spilled;
  £ value = PV-only bill reduction.
- Payback: `systemCost` adds Σ array cost; the card lists it.
- Day chart: actual generation as a solid area and the day-ahead forecast the plan used as a
  dashed line — the same plan-vs-reality convention as the state-of-charge trace — with PV
  export in the bars; flow diagram gains a sun node when PV > 0 in the slot. One colour,
  existing legend pattern. The monthly table gains a generation column.
- Ordering: all irradiance for the CSV's date range is fetched (or served from cache) before
  the replay starts, per array, actual and forecast alike; the loop only reads arrays. The
  Solar panel shows each array's annual kWh as soon as its fetch completes, before any run.
- Compare: arrays apply to every tariff pairing.

## UI

Panel **7 · Solar**, after 6 · Heat pump:

- Postcode input + **Locate** button → lat/lon shown; stored in `state.solar`.
- Array rows (add / remove): name, faces (compass °, with a helper select N/NE/…/NW that
  fills the number), tilt °, kWp, inverter kW, losses %, coupling (AC own inverter / DC
  into battery inverter), cost £.
- **Fetch irradiance** button (also triggered by Run if any array lacks data): per array,
  status line with progress; errors shown per array; cached results marked.
- Rows and postcode are saved with the other inputs (`form:controls` gains a `solar`
  object) and restored on load; irradiance series live in the rates cache.
- CSP `connect-src` adds `https://api.postcodes.io https://historical-forecast-api.open-meteo.com https://previous-runs-api.open-meteo.com`.

## Files

- `js/solar.js` (new): postcode lookup, per-array fetch + cache, GTI → kWh, series
  summing, `PvForecaster`. Pure functions unit-tested without network.
- `js/optimiser.js`: `chargeInSlot` unchanged; `dischargeBuckets` takes net load.
- `js/causal.js`: `solveHorizon` PV candidates and net load; `PvForecaster` import.
- `js/data.js`: `runReplay`/`runSim` PV execution, flows, accounting.
- `js/app.js`, `index.html`, `styles.css`: panel, cards, chart, CSP.
- `test/causal_model.py`: mirror of everything above; `test/gen_causal_fixtures.py`: two PV
  cases (AC and DC) with synthetic bell-curve PV × random cloud factor and a noisy day-ahead
  forecast; `test/causal.mjs`: guard rules above; `test/units.mjs`: solar helpers;
  `test/dom.mjs`: new ids.
- `test/score.mjs`: `--pv <json>` (the four series, written by a new `test/pv_fetch.mjs`
  that takes postcode + arrays and calls the same code paths in node) so gains are scored
  on the real year before shipping.
- README: Model bullets, Solar section, harness flags; `docs/plans/2026-09-04-planner-
  scoring.md` gains the PV rows.

## Verification

- Parity: the existing eleven fixture cases bit-exact with no arrays; two new PV cases
  bit-exact JS ↔ Python.
- Causality guard passes with the PV garbling rules.
- Physics asserted in `test/replay.mjs` on a synthetic sunny year: `pvToHouse + pvToBattery
  + pvExport + pvSpill = P` every slot; no slot both imports and exports; DC case respects
  `dcOut + dl + dx ≤ slotOut`; AC case respects `pvExport + dx ≤ exportCap`, and with a
  connection cap set no slot spills PV while the battery exports.
- Scorer on the user's year, south wall 4 kWp, Agile and Go: battery-only vs battery + PV,
  with and without export, compared against the pre-engine estimate (PV adds ~£390-410/yr
  on ERA5 numbers; expect ~20% less on the UK model).
- Browser: Playwright uploads the CSV, adds an array, fetches, runs, reloads, and checks the
  array row and irradiance cache come back; no page errors.
