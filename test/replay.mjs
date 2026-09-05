// Offline invariants: a synthetic no-DST year, plus a short run carrying real 46- and
// 50-slot DST days. No network, no CSV.
import { runSim } from '../js/data.js';
import { makeCfg } from '../js/optimiser.js';   // cfg.eff, for the PV wear assertion

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
// receding horizon: one plan at start, then a fresh plan at the start of every slot
ok('replay replans every slot', r.replans === DAYS * 48);
ok('replay carried is gone', !('carried' in r));
ok('replay plannedSoc present late',
   Number.isFinite(r.slots[DAYS * 48 - 10].plannedSoc));
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

// Self-use load-following: execution covers ACTUAL load beyond the plan when the pack
// has energy and the slot price beats the plan's marginal refill cost. The forecast
// cannot know about a one-off spike, so only load-following can cover it.
{
  const spikeLoad = load.slice();
  const spikeAt = 20 * 48 + 35;                       // day 21, 17:30 — a 38p peak slot
  spikeLoad[spikeAt] = 2.0;                           // one-off spike, ~10x the profile
  const rs = runSim({ usage, load: spikeLoad, imp, exp, scTotalP: 0,
                      params: { ...P, allowExport: false } });
  // scheduled-setpoint alone caps at the forecast (~1.0 here); following covers it all
  ok('load-following covers an unforecast spike',
     rs.slots[spikeAt].disLoad > 1.5);
  ok('load-following run stays clean', rs.socViolations === 0);
  // price floor: covering load costs a refill at >= cheapest charge price (12p) / eff,
  // so no slot may discharge to load at or below that — planned or opportunistic.
  ok('load-following never discharges below refill cost',
     rs.slots.every((s) => s.disLoad <= 1e-9 || s.imp > 12 / P.roundTrip));
}

// DST days: the clocks-forward day is 46 slots (01:00-02:00 never happens) and the
// clocks-back day is 50 (01:00-02:00 happens twice). Both land on the same slotOfDay
// index, so the repeated hour exercises dayBuf's averaging branch.
{
  const HHMM = [];
  for (let h = 0; h < 24; h++) for (const m of ['00', '30']) HHMM.push(`${String(h).padStart(2, '0')}:${m}`);
  const SKIP = HHMM.filter((t) => t !== '01:00' && t !== '01:30');                  // 46
  const REPEAT = [...HHMM.slice(0, 4), ...HHMM.slice(2, 4), ...HHMM.slice(4)];      // 50
  const DAYS_DST = [
    ['2025-03-28', HHMM], ['2025-03-29', HHMM], ['2025-03-30', SKIP], ['2025-03-31', HHMM],
    ['2025-10-24', HHMM], ['2025-10-25', HHMM], ['2025-10-26', REPEAT], ['2025-10-27', HHMM],
  ];
  const wall = [], localFloat = [], kwh = [];
  for (const [date, times] of DAYS_DST) {
    for (const t of times) {
      const w = `${date}T${t}`;
      wall.push(w);
      localFloat.push(Date.parse(`${w}:00Z`));       // wall clock read as UTC, offset-free
      const hh = Number(t.slice(0, 2));
      kwh.push(0.2 + (hh >= 17 && hh < 21 ? 0.6 : 0));
    }
  }
  const uD = { wall, localFloat, kwh, utc: wall };
  const lD = kwh.slice();
  const iD = lD.map((_, i) => (Number(wall[i].slice(11, 13)) < 6 ? 12 : 24));
  const eD = iD.map((v) => v * 0.6);
  const expect = 46 + 50 + 6 * 48;
  ok('DST synthetic has a 46- and a 50-slot day', wall.length === expect &&
     SKIP.length === 46 && REPEAT.length === 50);
  for (const cycle of ['scattered', 'contiguous']) {
    const rd = runSim({ usage: uD, load: lD, imp: iD, exp: eD, scTotalP: 0,
                        params: { ...P, cycle } });
    ok(`DST replay preserves slot count (${cycle})`,
       rd.slots.length === expect && rd.slots.every(Boolean));
    ok(`DST replay has no SOC violations (${cycle})`, rd.socViolations === 0);
    ok(`DST replay soc is finite everywhere (${cycle})`,
       rd.slots.every((s) => Number.isFinite(s.soc) && Number.isFinite(s.socPct)));
    ok(`DST replay plannedSoc never NaN (${cycle})`,
       rd.slots.every((s) => s.plannedSoc === null || Number.isFinite(s.plannedSoc)));
    ok(`DST replay totals are finite (${cycle})`,
       Number.isFinite(rd.energy) && Number.isFinite(rd.baseline) && Number.isFinite(rd.cycled));
  }
}

// ---- PV: physics invariants on a synthetic sunny year (AC and DC coupling)
{
  const T = DAYS * 48;
  const bell = (i) => { const hh = (i % 48) / 2; return hh > 6 && hh < 18 ? Math.pow(Math.sin(Math.PI * (hh - 6) / 12), 1.5) : 0; };
  const cloud = (i) => 0.35 + 0.65 * ((Math.floor(i / 48) * 7919) % 97) / 97;      // deterministic per-day factor
  const actual = new Float64Array(T).map((_, i) => 1.6 * bell(i) * cloud(i));      // ~4 kWp, kWh/half-hour
  const f1 = actual.map((v, i) => v * (0.8 + 0.4 * (((i * 31) % 53) / 53)));
  const f2 = actual.map((v, i) => v * (0.7 + 0.6 * (((i * 17) % 59) / 59)));
  const z = new Float64Array(T);
  const mkPv = (coupling) => (coupling === 'ac'
    ? { ac: actual, dc: z, acF1: f1, acF2: f2, dcF1: z, dcF2: z }
    : { ac: z, dc: actual, acF1: z, acF2: z, dcF1: f1, dcF2: f2 });
  const cfgP = makeCfg(P);
  const balanced = (rp) => rp.slots.every((s, i) =>
    Math.abs(s.pvToHouse + s.pvToBattery + s.pvExport + s.pvSpill - actual[i]) < 1e-9);
  const bothWays = (rp) => rp.slots.every((s) => !(s.gridImp > 1e-9 && s.gridExp > 1e-9));
  for (const coupling of ['ac', 'dc']) {
    const pv = mkPv(coupling);
    const rp = runSim({ usage, load, imp, exp, scTotalP: 0, params: { ...P, cycle: 'contiguous' }, pv });
    ok(`pv ${coupling}: every slot balances house + battery + export + spill = generation`, balanced(rp));
    ok(`pv ${coupling}: totals balance too`,
       Math.abs(rp.pvToHouse + rp.pvToBattery + rp.pvExport + rp.pvSpill - rp.pvKwh) < 1e-6);
    ok(`pv ${coupling}: no slot both imports and exports`, bothWays(rp));
    // PV charging is bounded by the ACTUAL surplus, so no slot ever imports to store PV
    ok(`pv ${coupling}: never imports while storing PV`,
       rp.slots.every((s) => !(s.pvToBattery > 1e-9 && s.gridImp > 1e-9)));
    ok(`pv ${coupling}: some surplus is stored`, rp.pvToBattery > 1);
    ok(`pv ${coupling}: wear counts PV charging`,
       rp.stored >= rp.pvToBattery * cfgP.eff - 1e-9 && rp.stored > 0);
    ok(`pv ${coupling}: soc clean`, rp.socViolations === 0);
    ok(`pv ${coupling}: PV lowers the bill`, rp.energy < r.energy - 10);
    if (coupling === 'dc') {
      // The inverter's AC output is the DC generation less what charged the pack DC-side
      // and less what the inverter clipped, shared with discharge. pvSpill lumps the clip
      // together with export-cap spill, so first pin down that the cap never binds here
      // (no connection limit is set, so exportCap is Infinity) — then pvSpill IS the clip
      // and the form below is exactly the AC output, not a bound slackened by cap spill.
      ok('pv dc: export cap never binds, so spill is inverter clipping alone',
         cfgP.exportCap === Infinity && rp.slots.every((s) => s.pvExport + s.disExp < cfgP.exportCap));
      const acOut = rp.slots.map((s) => s.pvGen - s.pvToBattery - s.pvSpill + s.disLoad + s.disExp);
      ok('pv dc: inverter output shared with discharge',
         acOut.every((v) => v <= P.inverterKw * 0.5 + 1e-6));
      ok('pv dc: the shared inverter output is actually reached',
         Math.max(...acOut) > P.inverterKw * 0.5 - 1e-6);
      // generation alone never fills the inverter here, so every overflow is contention
      // with discharge — absorbed by trimming battery export, never by spilling PV
      ok('pv dc: contention with discharge spills no PV', rp.pvSpill === 0);
    } else {
      // no connection cap here, so only the battery's own export is inverter-bound; the
      // AC array exports through its own inverter (arrayKwh already clipped it).
      ok('pv ac: battery export within the inverter export cap',
         rp.slots.every((s) => s.disExp <= P.inverterKw * 0.5 + 1e-6));
    }
  }
  // export disabled: PV still serves the house and charges, but nothing leaves the property
  for (const coupling of ['ac', 'dc']) {
    const rq = runSim({ usage, load, imp, exp, scTotalP: 0,
                        params: { ...P, cycle: 'contiguous', allowExport: false }, pv: mkPv(coupling) });
    ok(`pv ${coupling} no-export: slots still balance`, balanced(rq));
    ok(`pv ${coupling} no-export: nothing is exported`,
       rq.pvExport === 0 && rq.slots.every((s) => s.pvExport === 0 && s.gridExp <= 1e-12));
    ok(`pv ${coupling} no-export: no slot both imports and exports`, bothWays(rq));
  }
  // a DC array bigger than the inverter: generation alone overflows, so the clip is real
  // and cannot be absorbed by trimming battery export away
  {
    const big = actual.map((v) => v * 3);              // peaks ~4.7 kWh/half-hour vs a 2.5 cap
    const rb = runSim({ usage, load, imp, exp, scTotalP: 0, params: { ...P, cycle: 'contiguous' },
                        pv: { ac: z, dc: big, acF1: z, acF2: z, dcF1: big, dcF2: big } });
    ok('pv dc oversize: the inverter really clips', rb.pvSpill > 1);
    ok('pv dc oversize: every slot still balances', rb.slots.every((s, i) =>
       Math.abs(s.pvToHouse + s.pvToBattery + s.pvExport + s.pvSpill - big[i]) < 1e-9));
    ok('pv dc oversize: AC output stays within the inverter', rb.slots.every((s) =>
       s.pvGen - s.pvToBattery - s.pvSpill + s.disLoad + s.disExp <= P.inverterKw * 0.5 + 1e-6));
    ok('pv dc oversize: run stays clean', rb.socViolations === 0 && bothWays(rb));
    // A small hybrid inverter (0.8 kW -> 0.4 kWh/half-hour) under the same oversize array,
    // with the 0.8 kWh evening load above its rating while PV is still up: PV and
    // discharge both want the inverter while the house still has a deficit. The overflow
    // comes off discharge before it clips PV — the inverter's AC output is the same either
    // way, so the house is served identically and the pack keeps the energy. (With a 5 kW
    // inverter the load never exceeds its rating, so the branch cannot be reached above.)
    const rs = runSim({ usage, load, imp, exp, scTotalP: 0,
                        params: { ...P, cycle: 'contiguous', inverterKw: 0.8 },
                        pv: { ac: z, dc: big, acF1: z, acF2: z, dcF1: big, dcF2: big } });
    ok('pv dc small inverter: clips while the house still has a deficit',
       rs.slots.some((s, i) => s.pvSpill > 1e-9 && s.pvToHouse < load[i] - 1e-9));
    ok('pv dc small inverter: PV is clipped only once discharge to the house is exhausted',
       rs.slots.every((s) => s.pvSpill <= 1e-9 || s.disLoad <= 1e-9));
    ok('pv dc small inverter: every slot still balances', rs.slots.every((s, i) =>
       Math.abs(s.pvToHouse + s.pvToBattery + s.pvExport + s.pvSpill - big[i]) < 1e-9));
    ok('pv dc small inverter: AC output stays within the inverter', rs.slots.every((s) =>
       s.pvGen - s.pvToBattery - s.pvSpill + s.disLoad + s.disExp <= 0.4 + 1e-6));
    ok('pv dc small inverter: run stays clean', rs.socViolations === 0 && bothWays(rs));
  }
  // connection export cap: PV takes the cap before the battery does. Free PV that would
  // be spilled beats stored energy, which keeps its worth in the pack, so no slot may
  // spill PV while the battery is exporting.
  {
    const CAP = 0.5;                                    // 1.0 kW G100 -> 0.5 kWh/half-hour
    for (const coupling of ['ac', 'dc']) {
      const rk = runSim({ usage, load, imp, exp, scTotalP: 0,
                          params: { ...P, cycle: 'contiguous', exportLimitKw: 2 * CAP }, pv: mkPv(coupling) });
      ok(`pv ${coupling} export cap: total export never exceeds the cap`,
         rk.slots.every((s) => s.gridExp <= CAP + 1e-9));
      ok(`pv ${coupling} export cap: the cap actually binds`,
         rk.slots.some((s) => s.gridExp > CAP - 1e-9));
      ok(`pv ${coupling} export cap: PV is never spilled while the battery exports`,
         rk.slots.every((s) => s.pvSpill <= 1e-9 || s.disExp <= 1e-9));
      ok(`pv ${coupling} export cap: slots still balance`, balanced(rk));
      ok(`pv ${coupling} export cap: run stays clean`,
         rk.socViolations === 0 && bothWays(rk) && rk.slots.every((s) => Number.isFinite(s.soc)));
    }
  }
  // whole-house import cap: charge room is re-checked against the deficit AFTER PV
  {
    const rl = runSim({ usage, load, imp, exp, scTotalP: 0,
                        params: { ...P, cycle: 'contiguous', totalImportLimitKw: 6 }, pv: mkPv('ac') });
    ok('pv import cap: no slot imports past the whole-house limit',
       rl.slots.every((s) => s.gridImp <= 3 + 1e-9));
    ok('pv import cap: run stays clean', rl.socViolations === 0 && balanced(rl));
  }
  // pv = null keeps today's numbers
  const r0 = runSim({ usage, load, imp, exp, scTotalP: 0, params: P, pv: null });
  ok('pv null: unchanged energy', Math.abs(r0.energy - r.energy) < 1e-9 && r0.pvKwh === 0);
  ok('pv null: every PV total is zero', r0.pvToHouse === 0 && r0.pvToBattery === 0 &&
     r0.pvExport === 0 && r0.pvSpill === 0);
}

process.exit(fail ? 1 : 0);
