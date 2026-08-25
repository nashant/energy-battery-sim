// Live-API smoke: real Octopus prices + synthetic load through the causal engine.
// Invariant-based on purpose — exact figures live in test/causal.mjs fixtures.
import { buildPrices } from '../js/tariffs.js';
import { runSim } from '../js/data.js';

// ~60 recent days of synthetic evening-peaked usage (fixed-offset wall clock)
const wall = [], localFloat = [], kwh = [], utc = [];
const start = Date.now() - 63 * 86400000, t0 = start - (start % 1800000);
for (let i = 0; i < 60 * 48; i++) {
  const ms = t0 + i * 1800000;
  wall.push(new Date(ms).toISOString().slice(0, 16));
  utc.push(ms);                       // parseUsage's `utc` is ms; buildPrices needs instants

  localFloat.push(ms);
  const hh = new Date(ms).getUTCHours();
  kwh.push(0.25 + (hh >= 17 && hh < 21 ? 0.55 : 0));
}
const usage = { wall, localFloat, kwh, utc };
const prices = await buildPrices({ importKey: 'agile', exportKey: 'agile-outgoing',
                                   region: 'J', instants: usage.utc, flatExport: null });
const P = { capacity: 32, roundTrip: 0.9, dischargeFloorPct: 10, inverterKw: 10,
            exportLimitKw: null, totalImportLimitKw: null, maxChargePrice: null,
            cycle: 'contiguous', allowExport: true, useBattery: true };
const load = usage.kwh.slice();
const args = { usage, load, imp: prices.imp, exp: prices.exp, scTotalP: 0 };
const wb = runSim({ ...args, params: P });
const nb = runSim({ ...args, params: { ...P, useBattery: false } });
const g5 = runSim({ ...args, params: { ...P, exportLimitKw: 5 } });

let fail = 0;
const ok = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) fail++; };
console.log(`with battery £${wb.energy.toFixed(2)}  no battery £${nb.energy.toFixed(2)}  G100-5kW £${g5.energy.toFixed(2)}`);
ok('live: battery saves', wb.energy < nb.energy);
ok('live: no SOC violations', wb.socViolations === 0 && g5.socViolations === 0);
ok('live: G100 cap costs money (or ties)', g5.energy >= wb.energy - 1e-6);
ok('live: export bounded by G100', g5.maxExportSlot <= 2.5 + 1e-9);
process.exit(fail ? 1 : 0);
