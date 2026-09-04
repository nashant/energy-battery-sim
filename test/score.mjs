// Offline £/yr scorer: a REAL usage CSV against a REAL price CSV through the causal engine,
// forecaster parameters overridable per run; list-valued flags score their Cartesian product.
// Usage and flags are documented in README.md (Correctness).
import { readFileSync } from 'node:fs';
import { parseUsage, runSim } from '../js/data.js';
import { FORECAST_DEFAULTS } from '../js/causal.js';
import { parsePrices, alignPrices } from './prices_csv.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const list = (k, d) => String(args[k] ?? d).split(',').map((s) => s.trim());
const num = (s) => (s === '' || s === 'null' ? null : Number(s));
if (!args.usage || !args.prices) {
  console.error('usage: node test/score.mjs --usage <csv> --prices <csv> [options]');
  process.exit(2);
}

const usage = parseUsage(readFileSync(args.usage, 'utf8'));
const { imp, exp, dstFilled } = alignPrices(parsePrices(readFileSync(args.prices, 'utf8')), usage.utc);
const load = usage.kwh.slice();
const from = args.from ?? '0000';
const nDaysScored = new Set(usage.wall.map((w) => w.slice(0, 10)).filter((d) => d >= from)).size;
console.log(`${usage.utc.length} slots, ${usage.wall[0]} .. ${usage.wall.at(-1)}, ` +
            `${load.reduce((a, b) => a + b, 0).toFixed(0)} kWh; ${dstFilled} DST-repeat slots filled; ` +
            `scoring ${nDaysScored} days from ${from === '0000' ? 'start' : from}`);

const base = { ...FORECAST_DEFAULTS };
const rows = [];
for (const cap of list('cap', 32)) for (const inv of list('inv', 10))
for (const cycle of list('cycle', 'contiguous')) for (const ex of list('export', 0))
for (const holdFor of list('holdFor', 'anyCheaperRefill'))
for (const packEnergyWorth of list('packEnergyWorth', 'displacedPrice'))
for (const priceHorizon of list('priceHorizon', 'published'))
for (const replanEvery of list('replanEvery', 1))
for (const alpha of list('alpha', base.alpha)) for (const lam of list('lambda', base.lambdaFull))
for (const ramp of list('ramp', base.rampSlots)) {
  Object.assign(FORECAST_DEFAULTS, { alpha: +alpha, lambdaFull: +lam, rampSlots: +ramp });
  const params = {
    capacity: +cap, roundTrip: num(args.eff ?? 0.9), dischargeFloorPct: num(args.floor ?? 10),
    inverterKw: +inv, exportLimitKw: num(args.g100 ?? ''), totalImportLimitKw: null,
    maxChargePrice: num(args.maxchg ?? ''), cycle, allowExport: ex === '1', useBattery: true,
    holdFor, packEnergyWorth, priceHorizon, replanEvery: +replanEvery,
  };
  const t0 = performance.now();
  const wb = runSim({ usage, load, imp, exp, scTotalP: 0, params });
  const ms = performance.now() - t0;
  const days = wb.perDay.filter((d) => d.day >= from);
  const saved = days.reduce((a, d) => a + d.savedP, 0) / 100;
  const cost = days.reduce((a, d) => a + d.costP, 0) / 100;
  const nobat = days.reduce((a, d) => a + d.baseP, 0) / 100;
  const cycled = days.reduce((a, d) => a + d.kwhOut, 0);
  const exported = wb.slots.filter((x) => x.day >= from).reduce((a, x) => a + x.disExp, 0);
  rows.push({
    cap, inv, cycle, export: ex, holdFor, packEnergyWorth, priceHorizon, replanEvery,
    alpha, lambda: lam, ramp,
    'nobat £': nobat.toFixed(2), 'bat £': cost.toFixed(2), 'saved £': saved.toFixed(2),
    '£/yr': (saved * 365 / days.length).toFixed(2), 'kWh cycled': cycled.toFixed(0),
    'kWh exported': exported.toFixed(0),
    replans: wb.replans, viol: wb.socViolations, ms: ms.toFixed(0),
  });
  console.error(`  ${rows.length}: ${cap}kWh/${inv}kW ${cycle} export=${ex} ${holdFor} ${packEnergyWorth} ${priceHorizon} every=${replanEvery} α=${alpha} λ=${lam} ramp=${ramp} -> £${saved.toFixed(2)} exp ${exported.toFixed(0)} kWh (${ms.toFixed(0)} ms)`);
}
Object.assign(FORECAST_DEFAULTS, base);
console.table(rows);
