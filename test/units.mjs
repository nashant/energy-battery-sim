// Unit tests for the pure helpers in js/data.js — no network, no DOM.
import { paybackYears, sweepCapacities, sweepInverters, parseGas, gasImpliedRates } from '../js/data.js';

let fail = 0;
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) fail++; };
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// e = 0 degenerates to plain division
ok('payback e=0 is cost/save', close(paybackYears(3500, 1012, 0), 3500 / 1012));
ok('payback escPct omitted is cost/save', close(paybackYears(3500, 1012), 3500 / 1012));

// closed form: n = ln(1 + C·e/S) / ln(1+e); C=3500 S=1000 e=5% -> 3.30525…
const n = paybackYears(3500, 1000, 5);
ok('payback 5%/yr closed form', close(n, Math.log(1 + 3500 * 0.05 / 1000) / Math.log(1.05)));
// cross-check: cumulative saving S·((1+e)^n − 1)/e equals the cost at the crossing
ok('payback 5%/yr cumulative crossing', close(1000 * (Math.pow(1.05, n) - 1) / 0.05, 3500, 1e-6));

// negative escalation (falling prices) uses the same closed form, not plain division
const nNeg = paybackYears(3500, 1000, -3);
ok('payback -3%/yr differs from unescalated', !close(nNeg, 3.5, 1e-6));
ok('payback -3%/yr cumulative crossing',
   close(1000 * (Math.pow(0.97, nNeg) - 1) / -0.03, 3500, 1e-6));
// deflation steep enough that the saving never accumulates to the cost -> null
ok('payback null when deflation never repays', paybackYears(3500, 1000, -50) === null);

// guards
ok('payback null on zero cost', paybackYears(0, 1000, 5) === null);
ok('payback null on negative saving', paybackYears(3500, -5, 5) === null);
ok('payback null on zero saving', paybackYears(3500, 0, 5) === null);

import { gasBillPounds } from '../js/data.js';

// 5000 kWh matched gas (5200 metered − 200 unmatched) at 6.29p + 31.66p/day over 364 days
const bill = gasBillPounds({ gasKwh: 5200, unmatchedKwh: 200 }, 6.29, 31.66, 364);
ok('gas bill matched kWh + SC', close(bill, (5000 * 6.29 + 31.66 * 364) / 100, 1e-9));
ok('gas bill blank SC is rate only', close(gasBillPounds({ gasKwh: 5200, unmatchedKwh: 200 }, 6.29, null, 364), 5000 * 6.29 / 100));
ok('gas bill zero without unit rate', gasBillPounds({ gasKwh: 5200, unmatchedKwh: 200 }, null, 31.66, 364) === 0);
ok('gas bill zero for synthetic info', gasBillPounds({ hpKwh: 3000 }, 6.29, 31.66, 364) === 0);
ok('gas bill zero for null info', gasBillPounds(null, 6.29, 31.66, 364) === 0);

// implied gas rates derived from the CSV's own cost columns (Octopus gas export format)
const gasCsv = `Consumption (kwh), Estimated Cost Inc. Tax (p), Standing Charge Inc. Tax (p), Start, End
2.0000, 12, 15, 2026-07-28T00:00:00+01:00, 2026-07-28T00:30:00+01:00
1.0000, 6, 15, 2026-07-28T00:30:00+01:00, 2026-07-28T01:00:00+01:00
3.0000, 18, 30, 2026-07-29T00:00:00+01:00, 2026-07-29T00:30:00+01:00`;
const gasParsed = parseGas(gasCsv);
ok('parseGas keeps cost columns', close(gasParsed.actualP.reduce((a, b) => a + b, 0), 36)
   && close(gasParsed.scP.reduce((a, b) => a + b, 0), 60));
const ir = gasImpliedRates(gasParsed);
ok('implied gas unit rate = cost/kWh', close(ir.unitRateP, 36 / 6));
ok('implied gas SC/day over distinct days', close(ir.scPerDayP, 60 / 2));
const irZero = gasImpliedRates({ kwh: [1], utc: [0], actualP: [0], scP: [0] });
ok('implied rates null without cost data', irZero.unitRateP === null && irZero.scPerDayP === null);
const irLegacy = gasImpliedRates({ kwh: [1], utc: [0] });
ok('implied rates null for legacy gas shape', irLegacy.unitRateP === null && irLegacy.scPerDayP === null);

const caps = sweepCapacities(32);
ok('capacity grid for 32', JSON.stringify(caps) === JSON.stringify([16, 20, 24, 28, 32, 36, 40]));
ok('capacity grid contains the input', sweepCapacities(13.5).includes(13.5));
ok('capacity grid contains non-aligned input', sweepCapacities(13.55).includes(13.55));
ok('capacity grid is sorted with non-aligned input', sweepCapacities(13.55).every((v, i, a) => i === 0 || a[i-1] <= v));
ok('capacity grid rounds to 0.1', sweepCapacities(13.5).every((v) => close(v * 10, Math.round(v * 10))));
ok('capacity grid drops near-duplicate for non-aligned cap', sweepCapacities(13.44).length === 7);
ok('capacity grid keeps the raw non-aligned cap', sweepCapacities(13.44).includes(13.44));
ok('capacity grid drops the near-duplicate rounded value', !sweepCapacities(13.44).includes(13.4));
const invs = sweepInverters(10);
ok('inverter grid standard', JSON.stringify(invs) === JSON.stringify([3.6, 5, 6, 8, 10, 12]));
ok('inverter grid inserts odd size', JSON.stringify(sweepInverters(7)) === JSON.stringify([3.6, 5, 6, 7, 8, 10, 12]));


import { predictedExportKw } from '../js/data.js';

// voltage-rise ceiling: I = (Vmax − Vsrc)/Z, P = Vmax·I; 253 V = 230 V +10% statutory
ok('predict 242V 0.25Ω is 11.13 kW', close(predictedExportKw(242, 0.25), 253 * (253 - 242) / 0.25 / 1000));
ok('predict 242V 0.35Ω is 7.95 kW', close(predictedExportKw(242, 0.35), 253 * (253 - 242) / 0.35 / 1000));
ok('predict at statutory cap is 0', predictedExportKw(253, 0.25) === 0);
ok('predict above statutory cap is 0', predictedExportKw(258, 0.25) === 0);
ok('predict null on zero impedance', predictedExportKw(242, 0) === null);
ok('predict null on negative impedance', predictedExportKw(242, -0.1) === null);
ok('predict null on null voltage', predictedExportKw(null, 0.25) === null);
ok('predict null on zero voltage', predictedExportKw(0, 0.25) === null);

import { slotAtX } from '../js/data.js';

// slot i owns [L + i*w, L + (i+1)*w) in viewBox units, w = (R−L)/n; clamped at both ends
ok('slotAtX left edge is slot 0', slotAtX(40, 48) === 0);
ok('slotAtX left of plot clamps to 0', slotAtX(3, 48) === 0);
ok('slotAtX right edge clamps to n−1', slotAtX(460, 48) === 47);
ok('slotAtX beyond right clamps to n−1', slotAtX(479, 48) === 47);
ok('slotAtX slot-10 centre', slotAtX(40 + (420 / 48) * 10.5, 48) === 10);
ok('slotAtX DST short day', slotAtX(460 - 0.01, 46) === 45);
ok('slotAtX null for empty day', slotAtX(200, 0) === null);

import { Forecaster, FORECAST_DEFAULTS } from '../js/causal.js';

// cold start: zero forecast everywhere, ratio 1
{
  const f = new Forecaster();
  ok('forecaster cold start is zero', f.base('wd', 17) === 0);
  ok('forecaster cold ratio is 1', f.ratio() === 1);
  ok('forecaster cold forecast zeros',
     f.forecast([{ date: '2025-08-04', slotOfDay: 10 }], '2025-08-04')[0] === 0);
}
// seeding: first completed day IS the profile; EWMA thereafter
{
  const f = new Forecaster();
  const day = new Array(48).fill(0.5);
  f.completeDay('2025-08-04', day);                       // Monday -> wd seed
  ok('forecaster seeds first wd day', close(f.base('wd', 3), 0.5));
  ok('forecaster we falls back to wd', close(f.base('we', 3), 0.5));
  const day2 = new Array(48).fill(1.0);
  f.completeDay('2025-08-05', day2);                      // Tuesday -> EWMA
  ok('forecaster EWMA update', close(f.base('wd', 3), 0.15 * 1.0 + 0.85 * 0.5));
  const sat = new Array(48).fill(2.0);
  f.completeDay('2025-08-09', sat);                       // Saturday -> we seed
  ok('forecaster we seeds independently', close(f.base('we', 3), 2.0));
  ok('forecaster wd untouched by we day', close(f.base('wd', 3), 0.575));
}
// DST: null entries keep old profile value
{
  const f = new Forecaster();
  f.completeDay('2025-08-04', new Array(48).fill(1.0));
  const short = new Array(48).fill(0.4); short[2] = null;
  f.completeDay('2025-08-05', short);
  ok('forecaster null slot keeps old value', close(f.base('wd', 2), 1.0));
  ok('forecaster non-null slot updates', close(f.base('wd', 3), 0.15 * 0.4 + 0.85 * 1.0));
}
// intra-day ratio: dampened, ramping, never crossing day boundary
{
  const f = new Forecaster();
  f.completeDay('2025-08-04', new Array(48).fill(1.0));
  for (let s = 0; s < 8; s++) f.settle('2025-08-05', s, 2.0);   // running 2x profile
  // r=2, lambda = 0.75 * min(1, 8/16) = 0.375 -> ratio = 1 + 0.375*(2-1)
  ok('forecaster ratio ramps', close(f.ratio(), 1.375));
  const fc = f.forecast([{ date: '2025-08-05', slotOfDay: 20 },
                         { date: '2025-08-06', slotOfDay: 20 }], '2025-08-05');
  ok('forecaster ratio applies today', close(fc[0], 1.375));
  ok('forecaster ratio not tomorrow', close(fc[1], 1.0));
  f.completeDay('2025-08-05', new Array(48).fill(2.0));
  ok('forecaster ratio resets on day complete', f.ratio() === 1);
}
ok('forecaster dayType weekday', Forecaster.dayType('2025-08-04') === 'wd');
ok('forecaster dayType weekend', Forecaster.dayType('2025-08-09') === 'we');

import { solveHorizon } from '../js/causal.js';
import { makeCfg } from '../js/optimiser.js';

const CFG = makeCfg({ capacity: 10, roundTrip: 1, dischargeFloorPct: 0,
                      inverterKw: 20, totalImportLimitKw: null, maxChargePrice: null,
                      exportLimitKw: null });

// cheap->dear pairing, twice, no export. Slot 2 is 9p (not 10p) so the second
// pair's source is deterministic — with a tie the greedy would put both kWh at slot 0.
{
  const p = solveHorizon(0, [10, 30, 9, 30], [0, 0, 0, 0], [0, 1, 0, 1], CFG, 'scattered', false);
  ok('horizon pairs cheap->dear #1', close(p.chg.get(0) ?? 0, 1));
  ok('horizon pairs cheap->dear #2', close(p.chg.get(2) ?? 0, 1));
  ok('horizon discharges to load', close(p.discharge.get(1).load, 1));
  ok('horizon no unprofitable charge', (p.chg.get(1) ?? 0) === 0);
}
// initial SOC spent at the best slot, no charging needed
{
  const p = solveHorizon(1, [30, 10], [0, 0], [1, 0], CFG, 'scattered', false);
  ok('horizon spends soc0 at best value', close(p.discharge.get(0).load, 1));
  ok('horizon soc0 needs no charge', p.chg.size === 0);
  ok('horizon plannedSoc drains', close(p.plannedSoc[0], 0));
}
// full pack blocks charging until after discharge (headroom)
{
  const cfgSmall = makeCfg({ capacity: 1, roundTrip: 1, dischargeFloorPct: 0,
                             inverterKw: 20, totalImportLimitKw: null,
                             maxChargePrice: null, exportLimitKw: null });
  const p = solveHorizon(1, [5, 30, 6, 31], [0, 0, 0, 0], [0, 1, 0, 1], cfgSmall, 'scattered', false);
  // soc0 commits to slot 3 (val 31, best) first: minOver leaves nothing free for
  // slot 1's pairing, and slot 0 has zero headroom while holding that soc0 — so
  // slot 1 goes unserved by the battery.
  ok('horizon respects cap headroom', close(p.discharge.get(3).load, 1));
  ok('horizon blocked pair skipped', p.discharge.get(1) === undefined);
}
// energy-balance at the horizon: dear slot BEFORE cheap slot -> nothing to do
{
  const p = solveHorizon(0, [30, 10], [0, 0], [1, 0], CFG, 'scattered', false);
  ok('horizon never charges for beyond-horizon', p.chg.size === 0 && p.discharge.size === 0);
}
// maxChargePrice filter
{
  const cfgMax = { ...CFG, maxChgP: 5 };
  const p = solveHorizon(0, [10, 30], [0, 0], [0, 1], cfgMax, 'scattered', false);
  ok('horizon honours maxChargePrice', p.chg.size === 0);
}
// export + net settlement: exp > imp still serves load first
{
  const cfgX = makeCfg({ capacity: 10, roundTrip: 1, dischargeFloorPct: 0,
                         inverterKw: 2, totalImportLimitKw: null, maxChargePrice: null,
                         exportLimitKw: null });
  const p = solveHorizon(0, [5, 20], [0, 25], [0, 0.5], cfgX, 'scattered', true);
  const d = p.discharge.get(1);
  ok('horizon net settlement load first', close(d.load, 0.5));
  // slotOut = 1 kWh (2 kW): 0.5 to load, 0.5 to export
  ok('horizon export with remainder', close(d.export, 0.5));
}
// round-trip efficiency prices the charge correctly: spread must beat 1/eff
{
  const cfgE = makeCfg({ capacity: 10, roundTrip: 0.5, dischargeFloorPct: 0,
                         inverterKw: 20, totalImportLimitKw: null, maxChargePrice: null,
                         exportLimitKw: null });
  const pNo = solveHorizon(0, [10, 19], [0, 0], [0, 1], cfgE, 'scattered', false);
  ok('horizon eff kills thin spread', pNo.chg.size === 0);   // 10/0.5=20 > 19
  const pYes = solveHorizon(0, [10, 21], [0, 0], [0, 1], cfgE, 'scattered', false);
  ok('horizon eff allows fat spread', close(pYes.chg.get(0), 2)); // 1 kWh out needs 2 in
}
// trajectory invariant: plannedSoc must stay within [0, cfg.cap] for every slot —
// covers the cheap->dear pairing case, the cap-headroom case, and a reviewer
// counterexample that would overfill a 1 kWh pack if pass-2's charge decay didn't
// persist to the horizon end (addRange(...,c.t,T,q) must match commit()'s [b.t,T) decay)
{
  const cap1 = makeCfg({ capacity: 1, roundTrip: 1, dischargeFloorPct: 0,
                         inverterKw: 20, totalImportLimitKw: null,
                         maxChargePrice: null, exportLimitKw: null });
  const scenarios = [
    { p: solveHorizon(0, [10, 30, 9, 30], [0, 0, 0, 0], [0, 1, 0, 1], CFG, 'scattered', false), cap: CFG.cap },
    { p: solveHorizon(1, [5, 30, 6, 31], [0, 0, 0, 0], [0, 1, 0, 1], cap1, 'scattered', false), cap: cap1.cap },
  ];
  const pCounter = solveHorizon(0, [1, 40, 2, 30], [0, 0, 0, 0], [0, 1, 0, 2], cap1, 'scattered', false);
  scenarios.push({ p: pCounter, cap: cap1.cap });
  for (const { p, cap } of scenarios) {
    let inBounds = true;
    for (let t = 0; t < p.plannedSoc.length; t++) {
      if (!(p.plannedSoc[t] >= -1e-9 && p.plannedSoc[t] <= cap + 1e-9)) inBounds = false;
    }
    ok('horizon plannedSoc stays within [0, cap]', inBounds);
  }
  // no single charge event may exceed the pack cap (this is what the bug broke: the
  // buggy addRange(L,c.t,b.t,q) let slot 2 alone plan chg=2 into a 1 kWh/eff-1 pack
  // because its headroom check read a not-yet-decayed L; the total across the whole
  // plan, 2 kWh over two separate charge/discharge cycles, is legitimately > cap)
  const maxChg = Math.max(...pCounter.chg.values());
  ok('horizon counterexample single charge does not overfill 1 kWh pack', maxChg <= cap1.cap / cap1.eff + 1e-9);
}

// contiguous: one unbroken charge window, discharge after it. A 2 kW inverter
// (1 kWh/slot) forces the window to genuinely span two slots.
{
  const cfgC = makeCfg({ capacity: 10, roundTrip: 1, dischargeFloorPct: 0,
                         inverterKw: 2, totalImportLimitKw: null,
                         maxChargePrice: null, exportLimitKw: null });
  const p = solveHorizon(0, [10, 10, 30, 30], [0, 0, 0, 0], [0, 0, 1, 1], cfgC, 'contiguous', false);
  ok('contig charges a window', close((p.chg.get(0) ?? 0) + (p.chg.get(1) ?? 0), 2));
  ok('contig window is contiguous', p.window !== null && p.window[1] - p.window[0] === 1);
  ok('contig discharges after', close(p.discharge.get(2).load + p.discharge.get(3).load, 2));
}
// contiguous window skips a cheap-dear-cheap split it would need scattered mode for
{
  const p = solveHorizon(0, [10, 40, 10, 30, 30], [0, 0, 0, 0, 0], [0, 0.2, 0, 1, 1],
                         CFG, 'contiguous', false);
  // one window only; the 40p slot never charges
  ok('contig never charges the dear middle', (p.chg.get(1) ?? 0) === 0);
}
// contiguous respects held soc0 headroom
{
  const cfgSmall = makeCfg({ capacity: 2, roundTrip: 1, dischargeFloorPct: 0,
                             inverterKw: 20, totalImportLimitKw: null,
                             maxChargePrice: null, exportLimitKw: null });
  const p = solveHorizon(1.5, [5, 30, 30], [0, 0, 0], [0, 1, 1], cfgSmall, 'contiguous', false);
  // soc0 1.5 spent on the two 30p slots (pass 1); window at slot 0 has 0.5 headroom
  ok('contig headroom-limited fill', close(p.chg.get(0) ?? 0, 0.5));
}
// one-meter rule at the planner level: a slot either imports or exports, never both.
// Flat 12p import against a flat 15p export makes buy-and-resell inside one half-hour
// look like free money, which is exactly what a greedy pairer will book if unguarded.
{
  const cfgM = makeCfg({ capacity: 10, roundTrip: 0.9, dischargeFloorPct: 10,
                         inverterKw: 5, totalImportLimitKw: null,
                         maxChargePrice: null, exportLimitKw: null });
  const T = 12;
  const impF = new Array(T).fill(12), expF = new Array(T).fill(15), ldF = new Array(T).fill(0.3);
  for (const mode of ['scattered', 'contiguous']) {
    const p = solveHorizon(5, impF, expF, ldF, cfgM, mode, true);
    const both = [...p.chg.keys()].filter((t) => p.chg.get(t) > 1e-9 && p.discharge.has(t) &&
      p.discharge.get(t).load + p.discharge.get(t).export > 1e-9);
    ok(`horizon charge XOR discharge per slot (${mode})`, both.length === 0);
  }
  // pass 1 spends soc0 = 5 (usable cap 9, slotOut 2.5) over slots 0,1,2 as 2.5/2.5 pack-side
  // minus in-slot load netting, leaving slot 2 partly committed — so the contiguous window
  // can only start at slot 3, not slot 2.
  const pc = solveHorizon(5, impF, expF, ldF, cfgM, 'contiguous', true);
  ok('contig window starts after pass-1 discharge', pc.window !== null && pc.window[0] === 3);
}

import { roiPct } from '../js/data.js';

// simple year-1 return: annual saving over capex, as %/yr — reciprocal of unescalated payback
ok('roi 1012/yr on 3500 is 28.9%', close(roiPct(3500, 1012), 1012 / 3500 * 100));
ok('roi is reciprocal of simple payback', close(roiPct(3500, 1012), 100 / paybackYears(3500, 1012, 0)));
ok('roi negative saving reported honestly', close(roiPct(3500, -70), -2));
ok('roi null on zero cost', roiPct(0, 1000) === null);
ok('roi null on negative cost', roiPct(-1, 1000) === null);
ok('roi null on non-finite saving', roiPct(3500, NaN) === null);

// ---- cycle wear: cost spread over cycle life x usable capacity, p per pack-kWh
{
  const base = { capacity: 32, roundTrip: 0.9, dischargeFloorPct: 10, inverterKw: 10, batteryCost: 3500 };
  ok('wear is 0 without a cycle life', makeCfg(base).wearP === 0);
  ok('wear is 0 without a battery cost', makeCfg({ ...base, batteryCost: null, cycleLife: 8000 }).wearP === 0);
  ok('wear = cost*100 / (cycles * usable kWh)',
     close(makeCfg({ ...base, cycleLife: 8000 }).wearP, 350000 / (8000 * 28.8)));
  ok('wear uses the usable band, not the nameplate',
     close(makeCfg({ ...base, dischargeFloorPct: 0, cycleLife: 8000 }).wearP, 350000 / (8000 * 32)));
}

// ---- tariff pairings: js/tariffs.js `exports` lists mirror the Smart Tariffs T&Cs
import { IMPORT_TARIFFS, EXPORT_TARIFFS } from '../js/tariffs.js';
const tariffExports = (k) => IMPORT_TARIFFS[k].exports;
ok('every import lists at least one permitted export',
   Object.values(IMPORT_TARIFFS).every((t) => Array.isArray(t.exports) && t.exports.length > 0));
ok('every permitted export is a known export tariff',
   Object.values(IMPORT_TARIFFS).every((t) => t.exports.every((e) => e in EXPORT_TARIFFS)));
ok('flux pairs with flux export only (§2.7.1)',
   tariffExports('flux').length === 1 && tariffExports('flux')[0] === 'flux-export');
for (const k of ['go', 'cosy']) {
  ok(`${k} permits SEG, Outgoing and Agile Outgoing`,
     ['seg', 'outgoing-var', 'agile-outgoing'].every((e) => tariffExports(k).includes(e)));
  ok(`${k} excludes flux export and prime`,
     !tariffExports(k).includes('flux-export') && !tariffExports(k).includes('prime'));
}
ok('agile excludes flux export', !tariffExports('agile').includes('flux-export'));
ok('go defaults to no export', tariffExports('go')[0] === 'none');
ok('agile defaults to agile outgoing', tariffExports('agile')[0] === 'agile-outgoing');

// ---- solar helpers (js/solar.js): pure, no network
import { bearingToAzimuth, toHalfHours, alignToUsage, arrayKwh, sumArrays } from '../js/solar.js';
ok('azimuth: south wall is 0', bearingToAzimuth(180) === 0);
ok('azimuth: east is -90', bearingToAzimuth(90) === -90);
ok('azimuth: west is 90', bearingToAzimuth(270) === 90);
ok('azimuth: north is 180', bearingToAzimuth(0) === 180);
ok('azimuth: 191 -> 11', bearingToAzimuth(191) === 11);
{
  // hourly value at 11:00 is the mean over 10:00-11:00 -> both half hours of that hour
  const m = toHalfHours(['2026-06-01T10:00', '2026-06-01T11:00'], [100, 300], 60);
  const t10 = Date.UTC(2026, 5, 1, 10), t1030 = Date.UTC(2026, 5, 1, 10, 30);
  ok('hourly -> both preceding half hours', m.get(t10) === 300 && m.get(t1030) === 300);
  ok('hourly -> earlier hour covers 09:00 and 09:30',
     m.get(Date.UTC(2026, 5, 1, 9)) === 100 && m.get(Date.UTC(2026, 5, 1, 9, 30)) === 100);
  // 15-minutely values at :15 and :30 average into the half hour starting :00
  const q = toHalfHours(['2026-06-01T10:15', '2026-06-01T10:30', '2026-06-01T10:45', '2026-06-01T11:00'],
                        [100, 200, 300, 500], 15);
  ok('15-min -> mean of the two preceding quarters', q.get(t10) === 150 && q.get(t1030) === 400);
  ok('15-min null counts as 0 in the mean',
     toHalfHours(['2026-06-01T10:15', '2026-06-01T10:30'], [null, 200], 15).get(t10) === 100);
}
{
  const t0 = Date.UTC(2025, 9, 26, 0);                       // 2025-10-26, clocks go back
  const m = new Map([[t0, 10], [t0 + 1800000, 20]]);
  const r = alignToUsage(m, [t0, t0 + 1800000, t0 + 3600000, t0 + 5400000, t0 + 7200000]);
  ok('align: exact hits', r.values[0] === 10 && r.values[1] === 20);
  ok('align: repeat hour filled from an hour earlier', r.values[2] === 10 && r.values[3] === 20 && r.filled === 2);
  ok('align: otherwise 0 and counted missing', r.values[4] === 0 && r.missing === 1);
}
{
  const arr = { kwp: 4, lossPct: 14, inverterKw: 3.68, coupling: 'ac' };
  const k = arrayKwh([0, 500, 1000, 1200], arr);
  ok('kWh: 500 W/m2 on 4 kWp at 14% loss = 0.86 kWh/half-hour', close(k[1], 0.5 * 4 * 0.86 * 0.5));
  ok('kWh: AC inverter clips at 3.68 kW -> 1.84 kWh', close(k[3], 1.84) && close(k[2], 1.72));
  ok('kWh: DC array is not clipped here', close(arrayKwh([1200], { ...arr, coupling: 'dc' })[0], 1.2 * 4 * 0.86 * 0.5));
  ok('kWh: null irradiance is 0', arrayKwh([null], arr)[0] === 0);
}
{
  const a = { coupling: 'ac' }, d = { coupling: 'dc' };
  const s = sumArrays([{ arr: a, actual: [1, 2], f1: [1, 1], f2: [2, 2] },
                       { arr: d, actual: [3, 4], f1: [0, 1], f2: [0, 2] }], 2);
  ok('sum: ac and dc split by coupling', s.ac[1] === 2 && s.dc[1] === 4);
  ok('sum: forecasts split too', s.acF1[0] === 1 && s.dcF2[1] === 2);
  ok('sum: typed arrays of length T', s.ac.length === 2 && s.acF2 instanceof Float64Array);
}

// ---- PvForecaster: causal lead-time choice + intra-day ratio
import { PvForecaster } from '../js/causal.js';
{
  const T = 200, z = () => new Float64Array(T);
  const pv = { ac: z(), dc: z(), acF1: z(), acF2: z(), dcF1: z(), dcF2: z() };
  pv.acF1.fill(1.0); pv.acF2.fill(0.5); pv.ac.fill(2.0);
  const f = new PvForecaster(pv);
  ok('pv base uses day-1 forecast when it was issued 24 h before the slot', f.base(100, 60).ac === 1.0);
  ok('pv base falls back to day-2 when day-1 would not exist yet', f.base(120, 60).ac === 0.5);
  ok('pv base boundary: t - 48 == now is day-1', f.base(108, 60).ac === 1.0);
  ok('pv cold ratio is 1', f.ratio() === 1);
  for (let t = 0; t < 8; t++) f.settle(t);              // actual 2.0 vs forecast 1.0 -> r = 2
  ok('pv ratio ramps to lambda after 8 daylight slots', close(f.ratio(), 1 + 0.75 * (2 - 1)));
  const cal = new Array(T).fill('d1'); for (let t = 48; t < T; t++) cal[t] = 'd2';
  const fc = f.forecast(8, 60, cal);
  ok('pv forecast scales today only', close(fc.ac[0], 1.75) && close(fc.ac[45], 1.0));
  f.completeDay();
  ok('pv ratio resets at day end', f.ratio() === 1);
  // null forecast values fall back to the other lead time, then 0
  const pv2 = { ...pv, acF1: new Float64Array(T).fill(NaN), acF2: new Float64Array(T).fill(0.3) };
  ok('pv base null day-1 falls back to day-2', new PvForecaster(pv2).base(50, 50).ac === 0.3);
}

process.exit(fail ? 1 : 0);
