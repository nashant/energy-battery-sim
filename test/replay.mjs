// Offline invariants on a synthetic no-DST year. No network, no CSV.
import { runSim } from '../js/data.js';

let fail = 0;
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) fail++; };

// Synthetic usage: fixed +00:00 offset (a fictional no-DST region is valid input).
function synth(days) {
  const wall = [], localFloat = [], kwh = [];
  const t0 = Date.UTC(2025, 0, 6);                      // a Monday
  for (let d = 0; d < days; d++) {
    for (let s = 0; s < 48; s++) {
      const ms = t0 + (d * 48 + s) * 1800000;
      wall.push(new Date(ms).toISOString().slice(0, 16));
      localFloat.push(ms);
      // evening-peaked house: 0.2 base + 0.6 through 17:00-21:00, weekend +25%
      const hh = s / 2, we = new Date(ms).getUTCDay() % 6 === 0;
      kwh.push((0.2 + (hh >= 17 && hh < 21 ? 0.6 : 0)) * (we ? 1.25 : 1));
    }
  }
  return { wall, localFloat, kwh, utc: wall };
}
// Agile-shaped synthetic prices: cheap overnight, evening spike.
const priceAt = (s) => { const hh = (s % 48) / 2;
  return hh < 6 ? 12 : hh >= 16 && hh < 19 ? 38 : 24; };

const DAYS = 40;
const usage = synth(DAYS);
const load = usage.kwh.slice();
const imp = load.map((_, i) => priceAt(i));
const exp = load.map((_, i) => priceAt(i) * 0.6);
const P = { capacity: 10, roundTrip: 0.9, dischargeFloorPct: 10, inverterKw: 5,
            exportLimitKw: null, totalImportLimitKw: null, maxChargePrice: null,
            cycle: 'scattered', allowExport: true, useBattery: true };

const r = runSim({ usage, load, imp, exp, scTotalP: 0, params: P });
const n = runSim({ usage, load, imp, exp, scTotalP: 0, params: { ...P, useBattery: false } });

ok('replay covers every slot', r.slots.length === DAYS * 48 && r.slots.every(Boolean));
ok('replay has no SOC violations', r.socViolations === 0);
ok('replay saves money', r.energy < n.energy - 1);
ok('replay no-battery baseline matches', Math.abs(n.energy - n.baseline) < 1e-6);
ok('replay reports warmup', r.warmupDays === 14);
ok('replay replans daily-ish', r.replans >= DAYS - 1 && r.replans <= DAYS * 3);
ok('replay carried is gone', !('carried' in r));
ok('replay plannedSoc present late', r.slots[DAYS * 48 - 10].plannedSoc !== null);
// causal cold start: with export disabled and no load forecast yet, day 1 has
// nothing to optimise — no charging, no discharge. (With export enabled, day-1
// arbitrage IS expected, and execution nets planned export to actual load first,
// so asserting on the export run would be wrong.)
const rn0 = runSim({ usage, load, imp, exp, scTotalP: 0, params: { ...P, allowExport: false } });
const day1 = rn0.slots.slice(0, 48);
ok('replay day-1 cold start does nothing (no export)',
   day1.every((s) => s.chg <= 1e-9 && s.disLoad <= 1e-9));
// contiguous mode also runs clean
const rc = runSim({ usage, load, imp, exp, scTotalP: 0, params: { ...P, cycle: 'contiguous' } });
ok('replay contiguous clean', rc.socViolations === 0 && rc.energy < n.energy - 1);
// maxChargePrice honoured in execution
const rm = runSim({ usage, load, imp, exp, scTotalP: 0, params: { ...P, maxChargePrice: 13 } });
ok('replay maxChgP honoured', rm.slots.every((s) => s.chg <= 1e-9 || s.imp <= 13));

// One-meter rule: a half-hour is either importing or exporting, never both. The nasty
// case is export priced ABOVE import, which makes buy-and-immediately-resell look free
// money to a greedy pairer. Parity fixtures can't catch this — both languages would
// share the bug faithfully — so it lives here as a permanent invariant.
const expHigh = imp.map((v) => v * 1.25);
for (const cycle of ['scattered', 'contiguous']) {
  const rx = runSim({ usage, load, imp, exp: expHigh, scTotalP: 0, params: { ...P, cycle } });
  const both = rx.slots.filter((s) => s.gridImp > 1e-9 && s.gridExp > 1e-9);
  ok(`one-meter rule: no slot both imports and exports (${cycle})` +
     (both.length ? ` (${both.length} slots, first ${both[0].wall})` : ''), both.length === 0);
  ok(`one-meter run still clean (${cycle})`, rx.socViolations === 0 &&
     rx.slots.length === DAYS * 48 && rx.slots.every((s) => Number.isFinite(s.soc)));
}

process.exit(fail ? 1 : 0);
