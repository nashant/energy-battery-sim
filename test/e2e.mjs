// End-to-end check: drives the SAME modules the browser loads (live API fetch included)
// and compares whole-year totals against the Python CLI's published figures.
// IndexedDB is absent in node; the cache layer swallows that and fetches every time.
import { readFileSync } from 'node:fs';
import { buildPrices } from '../js/tariffs.js';
import { parseUsage, runSim, currentTariffTotal } from '../js/data.js';

const text = readFileSync(process.argv[2] || '/home/anthonynash/Downloads/octopus-usage.csv', 'utf8');
const usage = parseUsage(text);
console.log(`parsed ${usage.utc.length} slots, ${usage.kwh.reduce((a, b) => a + b, 0).toFixed(0)} kWh, ` +
            `${usage.wall[0]} -> ${usage.wall[usage.wall.length - 1]}`);

const cur = currentTariffTotal(usage, null);
console.log(`current tariff: £${cur.total.toFixed(2)}  (expect 1726.82)\n`);

const BASE = { capacity: 32, roundTrip: 0.9, cycle: 'scattered', boundary: 'midnight',
               exportLimitKw: null, totalImportLimitKw: null, maxChargePrice: null };

// Region J. `expect` is this app's full-precision figure under the current model (net
// settlement + hold-across-boundary pass, 2026-08-05 — the agile 10kW figures match the
// Python mirror test/pymodel.py to the penny). `was` is the pre-hold-pass figure, kept to
// show what the model change was worth; the standalone Python CLI still reports ~those.
const CASES = [
  { name: 'agile + outgoing, 6kW',   i: 'agile', e: 'agile-outgoing', kw: 6,  expect: 776.62, was: 823.62 },
  { name: 'agile + outgoing, 10kW',  i: 'agile', e: 'agile-outgoing', kw: 10, expect: 666.33, was: 703.22 },
  { name: 'agile, no export, 6kW',   i: 'agile', e: 'none',           kw: 6,  expect: 1064.15, was: 1086.99 },
  { name: 'go, no export, 6kW',      i: 'go',    e: 'none',           kw: 6,  expect: 752.45, was: 752.46 },
  { name: 'flux + flux export, 10kW',i: 'flux',  e: 'flux-export',    kw: 10, expect: 652.23, was: 652.23 },
  { name: 'cosy + outgoing, 10kW',   i: 'cosy',  e: 'agile-outgoing', kw: 10, expect: 883.90, was: 955.12 },
  { name: 'agile+outgoing 10kW G100 5kW', i: 'agile', e: 'agile-outgoing', kw: 10,
    extra: { exportLimitKw: 5 }, expect: 728.29, was: 779.02 },
  { name: 'agile+outgoing 10kW, cycle', i: 'agile', e: 'agile-outgoing', kw: 10,
    extra: { boundary: 'cycle' }, expect: 663.52, was: 680.63 },
  // the app's DEFAULT strategy since 2026-08-05: contiguous + adaptive boundary
  { name: 'agile+outgoing 10kW cycle+contig (defaults)', i: 'agile', e: 'agile-outgoing',
    kw: 10, extra: { boundary: 'cycle', cycle: 'contiguous' }, expect: 673.68, was: 689.25 },
  { name: 'agile+outgoing 6kW, cycle', i: 'agile', e: 'agile-outgoing', kw: 6,
    extra: { boundary: 'cycle' }, expect: 771.36, was: 798.12 },
  // UI defaults incl. the 10% discharge floor (usable 28.8 kWh); `was` = no-floor figure.
  // Cross-checked vs pymodel at capacity 28.8: £716.96 on 2dp CSV prices (1p rounding).
  { name: 'defaults: contig+cycle, 10% floor', i: 'agile', e: 'agile-outgoing', kw: 10,
    extra: { boundary: 'cycle', cycle: 'contiguous', dischargeFloorPct: 10 },
    expect: 716.95, was: 673.68 },
];

let bad = 0;
for (const c of CASES) {
  const p = { ...BASE, ...c.extra, inverterKw: c.kw, allowExport: c.e !== 'none' };
  const pr = await buildPrices({ importKey: c.i, exportKey: c.e, region: 'J',
                                 instants: usage.utc, flatExport: null });
  const r = runSim({ usage, load: usage.kwh.slice(), imp: pr.imp, exp: pr.exp,
                     scTotalP: pr.scTotalP, params: { ...p, useBattery: true } });
  const diff = Math.abs(r.total - c.expect);
  const ok = diff < 0.02;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(24)} total £${r.total.toFixed(2).padStart(9)} ` +
              `sc £${r.sc.toFixed(2)}  cycled ${r.cycled.toFixed(0)}  ` +
              `carried ${r.carried.toFixed(0)} kWh  socViolations ${r.socViolations}  ` +
              `(pre-hold £${c.was.toFixed(2)})` +
              (ok ? '' : `  DIFF £${diff.toFixed(2)}`));
}
console.log(bad ? `\n${bad} case(s) FAILED` : '\nall cases match expected values');
process.exit(bad ? 1 : 0);
