# energy-battery-sim

Static site: plain HTML + CSS + ES modules, no framework, no bundler, no build step.
Served straight from the repo root (`index.html` + `js/*.js`), deployed by GitHub Pages
from `main` — so anything on `main` is live.

## Workflow

**Work lands directly on `main`.** No feature branch, no pull request — commit to `main`
and push. This is a solo repo with no CI; PR #1 was opened by mistake and immediately
fast-forwarded onto `main`. Check `git log` before assuming otherwise.

Amend rather than stacking fixup commits while a change is still unpushed.

## Verification

There is no CI, so run the suites yourself before pushing:

```sh
node test/units.mjs      # pure helpers in js/data.js — no network, no DOM
node test/replay.mjs     # offline invariants: synthetic year + 46/50-slot DST days
node test/causal.mjs     # JS vs Python parity, plus the causality guard
node test/dom.mjs        # index.html/app.js id cross-check (its browser half needs a CSV)
```

`test/dom.mjs` fails after its id check because it wants `~/Downloads/octopus-usage.csv`,
which does not exist — the id cross-check above it is the part that matters.

The real-data scorers need the household CSVs, which live in `~/.local/share/Trash/files/`
(`usage-electric.csv`, `usage-gas.csv`, `prices-agile-J.csv`) and read fine from there:

```sh
node test/score.mjs --usage <csv> --prices <csv>          # £402.55 anchor, 32 kWh / 10 kW
```

Playwright checks (`test/solar_toggle.py`, `test/browser.py`) each serve the repo themselves
on a spare port and take a few minutes — run them in background.

## Conventions

- Commit subjects are `area: lower-case summary` (`results:`, `planner:`, `ui:`, `hot water:`).
- Prices are pence per kWh in the model and only become £ at the render boundary.
- Rates are keyed by **UTC instant** so both DST changeover hours are unambiguous; the
  **local wall clock** (`usage.wall`, `gas.wall`, `"YYYY-MM-DD HH:MM"`) is for day and
  time-of-day bucketing. Do not mix the two for the same purpose.
- Comments say *why*, not *what*. Match the density already in `js/data.js`.
