// Offline £/yr scorer for the opportunistic immersion: a REAL gas CSV (the metered cylinder
// reheat) and a REAL price CSV through immersionFromGas. Answers "what would running the
// immersion instead of the boiler, but only when electricity is genuinely cheaper, be worth?"
import { readFileSync } from 'node:fs';
import { parseUsage, parseGas, immersionFromGas, gasImpliedRates } from '../js/data.js';
import { parsePrices, alignPrices } from './prices_csv.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const num = (k, d) => (args[k] === undefined ? d : Number(args[k]));
if (!args.usage || !args.prices || !args.gas) {
  console.error('usage: node test/immersion.mjs --usage <csv> --gas <csv> --prices <csv> [options]');
  process.exit(2);
}

const usage = parseUsage(readFileSync(args.usage, 'utf8'));
const gas = parseGas(readFileSync(args.gas, 'utf8'));
const flat = args.flat === undefined ? null : Number(args.flat);
const { imp, exp } = flat === null
  ? alignPrices(parsePrices(readFileSync(args.prices, 'utf8')), usage.utc)
  : { imp: usage.utc.map(() => flat), exp: usage.utc.map(() => 0) };

const hhmm = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const o = {
  windowFrom: hhmm(args.blockFrom ?? '00:00'), windowTo: hhmm(args.blockTo ?? '10:00'),
  runFrom: hhmm(args.runFrom ?? '00:00'), runTo: hhmm(args.runTo ?? '05:00'),
  immersionKw: num('kw', 3), boilerEff: num('eff', 0.85),
  gasUnitRateP: args.gasRate === undefined ? gasImpliedRates(gas).unitRateP : Number(args.gasRate),
  headroomPct: num('headroom', 0), litres: num('litres', 200),
  setpointC: num('setpoint', 60), coldC: num('cold', 15),
  standingLossKwhPerDay: num('loss', 0),
  dhwDailyGasKwh: args.dhw === undefined ? null : Number(args.dhw),
};

const { info } = immersionFromGas(usage, gas, imp, exp, null, o);
const days = new Set(usage.wall.map((w) => w.slice(0, 10))).size;
const yr = 365 / days;
const gasCostP = info.heatNeeded / o.boilerEff * o.gasUnitRateP;
const saveP = info.gasSavedP - info.elecCostP;
console.log(`${days} days, gas ${o.gasUnitRateP.toFixed(3)} p/kWh, boiler ${o.boilerEff}, ` +
            `breakeven ${info.breakevenP.toFixed(2)} p/kWh, cylinder ${info.capKwh.toFixed(1)} kWh` +
            (info.halfHourly ? '' : '  [WARNING: gas CSV is not half-hourly; the block split is meaningless]'));
console.log(`hot-water baseline ${info.dhwGasPerDay?.toFixed(2)} kWh gas/day in the block ` +
            `(from ${info.dhwMonths?.join(', ') ?? 'manual'}) -> daily cap ${info.dailyCap.toFixed(2)} kWh heat`);
console.log(`block ${args.blockFrom ?? '00:00'}-${args.blockTo ?? '10:00'} costs ` +
            `£${(gasCostP / 100).toFixed(2)} on gas (£${(gasCostP / 100 * yr).toFixed(2)}/yr)`);
console.log(`fired on ${info.daysFired}/${info.daysTotal} days, moved ${info.heatMoved.toFixed(0)} of ` +
            `${info.heatNeeded.toFixed(0)} kWh heat, drew ${info.elecKwh.toFixed(0)} kWh for ` +
            `£${(info.elecCostP / 100).toFixed(2)}, gas saved £${(info.gasSavedP / 100).toFixed(2)}`);
console.log(`SAVING £${(saveP / 100).toFixed(2)} over the window = £${(saveP / 100 * yr).toFixed(2)}/yr`);
