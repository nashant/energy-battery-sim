// Octopus usage CSVs carry the local wall clock WITH its offset ("2025-08-04T00:00:00+01:00"),
// so wall clock comes from the string and the UTC instant from Date.parse — no timezone
// library needed, and correct across both DST changeovers.

import { Forecaster, PvForecaster, FORECAST_DEFAULTS, solveHorizon } from './causal.js';
// chargeInSlot is here because runReplay re-checks charge room against ACTUAL load
// at execution time, not the forecast the plan was built on
import { makeCfg, chargeInSlot } from './optimiser.js';

const M3_TO_KWH = 1.02264 * 39.5 / 3.6;   // volume correction x calorific value / 3.6

// fraction of annual heat-pump electricity by month (Jan..Dec)
export const HP_MONTHLY = [0.160, 0.140, 0.115, 0.075, 0.035, 0.012,
                           0.008, 0.008, 0.025, 0.080, 0.132, 0.210];
// relative weight by hour; a weather-compensated heat pump runs near-continuously
export const HP_DIURNAL = [0.9, 0.9, 0.95, 1.0, 1.1, 1.2, 1.25, 1.2, 1.1, 1.0, 0.95, 0.9,
                           0.85, 0.8, 0.8, 0.85, 1.0, 1.15, 1.2, 1.15, 1.05, 1.0, 0.95, 0.9];

function splitCsv(text) {
  // the picker no longer filters by extension, so say something useful when the file
  // isn't text at all -- Octopus downloads sometimes arrive zipped
  if (/^PK\x03\x04/.test(text)) {
    throw new Error('this is a zip or spreadsheet file, not a CSV. Extract the .csv from ' +
                    'it (or re-export as CSV) and try again.');
  }
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new Error('file is empty');
  if (!lines[0].includes(',')) {
    throw new Error(`no commas in the first line, so this does not look like a CSV. ` +
                    `It starts: "${lines[0].slice(0, 60)}"`);
  }
  const head = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const cells = l.split(',');
    const o = {};
    head.forEach((h, i) => { o[h] = (cells[i] ?? '').trim(); });
    return o;
  });
}

function findCol(keys, ...wants) {
  for (const w of wants) {
    const hit = keys.find((k) => k.toLowerCase().includes(w));
    if (hit) return hit;
  }
  return null;
}

export function parseUsage(text) {
  const rows = splitCsv(text);
  const keys = Object.keys(rows[0]);
  const kc = findCol(keys, 'consumption (kwh)', 'consumption');
  const cc = findCol(keys, 'estimated cost');
  const sc = findCol(keys, 'standing charge');
  const st = findCol(keys, 'start');
  if (!kc || !st) {
    throw new Error(`Need a consumption column and a Start column. Found: ${keys.join(', ')}`);
  }
  const out = { utc: [], localFloat: [], wall: [], kwh: [], actualP: [], scP: [] };
  for (const r of rows) {
    const s = r[st];
    const utc = Date.parse(s);
    if (Number.isNaN(utc)) continue;
    // strip the offset to get the local wall clock, then read it as a floating instant
    const lf = Date.parse(s.slice(0, 19) + 'Z');
    out.utc.push(utc);
    out.localFloat.push(Number.isNaN(lf) ? utc : lf);
    out.wall.push(s.slice(0, 16).replace('T', ' '));
    out.kwh.push(parseFloat(r[kc]) || 0);
    out.actualP.push(cc ? (parseFloat(r[cc]) || 0) : 0);
    out.scP.push(sc ? (parseFloat(r[sc]) || 0) : 0);
  }
  if (!out.utc.length) throw new Error('No parseable rows — check the Start column format.');
  const order = [...out.utc.keys()].sort((a, b) => out.utc[a] - out.utc[b]);
  const sorted = {};
  for (const k of Object.keys(out)) sorted[k] = order.map((i) => out[k][i]);
  return sorted;
}

export function parseGas(text) {
  const rows = splitCsv(text);
  const keys = Object.keys(rows[0]);
  const kc = findCol(keys, 'consumption (kwh)');
  const mc = findCol(keys, 'm3', 'm³', 'cubic', 'consumption (m');
  const cc = findCol(keys, 'estimated cost');
  const sc = findCol(keys, 'standing charge');
  const st = findCol(keys, 'start');
  if (!st || (!kc && !mc)) {
    throw new Error(`Gas CSV needs a Start column and a kWh or m³ column. Found: ${keys.join(', ')}`);
  }
  const out = { utc: [], kwh: [], actualP: [], scP: [], unit: kc ? 'kWh' : 'm³' };
  for (const r of rows) {
    const utc = Date.parse(r[st]);
    if (Number.isNaN(utc)) continue;
    let k = NaN;
    if (kc && r[kc] !== '') k = parseFloat(r[kc]);
    if (Number.isNaN(k) && mc && r[mc] !== '') k = parseFloat(r[mc]) * M3_TO_KWH;
    if (Number.isNaN(k)) continue;
    out.utc.push(utc);
    out.kwh.push(k);
    out.actualP.push(cc ? (parseFloat(r[cc]) || 0) : 0);
    out.scP.push(sc ? (parseFloat(r[sc]) || 0) : 0);
  }
  if (!out.utc.length) throw new Error('No parseable gas rows.');
  return out;
}

// Implied gas prices from the CSV's own cost columns (same idea as the electricity
// side's implied rate in currentTariffTotal): unit rate = total cost / total kWh,
// standing charge = total SC / distinct days covered. Nulls when the columns are
// absent or empty — the caller falls back to manual inputs or warns.
export function gasImpliedRates(gas) {
  if (!gas || !gas.actualP || !gas.scP) return { unitRateP: null, scPerDayP: null };
  const kwh = gas.kwh.reduce((a, b) => a + b, 0);
  const cost = gas.actualP.reduce((a, b) => a + b, 0);
  const sc = gas.scP.reduce((a, b) => a + b, 0);
  const days = new Set(gas.utc.map((t) => new Date(t).toISOString().slice(0, 10))).size;
  return {
    unitRateP: kwh > 0 && cost > 0 ? cost / kwh : null,
    scPerDayP: sc > 0 && days > 0 ? sc / days : null,
  };
}

// Metered gas -> useful heat (x boiler efficiency) -> electricity (/ COP).
// Uses the real metered shape, so no synthetic profile is needed.
export function heatPumpFromGas(usage, gas, boilerEff, cop) {
  const idx = new Map();
  usage.utc.forEach((t, i) => idx.set(t, i));
  const dayIdx = new Map();
  usage.localFloat.forEach((t, i) => {
    const d = new Date(t).toISOString().slice(0, 10);
    if (!dayIdx.has(d)) dayIdx.set(d, []);
    dayIdx.get(d).push(i);
  });

  const add = new Array(usage.utc.length).fill(0);
  const coveredDays = new Set();
  let unmatched = 0, spread = 0;
  for (let g = 0; g < gas.utc.length; g++) {
    coveredDays.add(new Date(gas.utc[g]).toISOString().slice(0, 10));
    const e = gas.kwh[g] * boilerEff / cop;
    const i = idx.get(gas.utc[g]);
    if (i !== undefined) { add[i] += e; continue; }
    // gas may be metered on a coarser cadence (often daily); spread across that day
    const d = new Date(gas.utc[g]).toISOString().slice(0, 10);
    const slots = dayIdx.get(d);
    if (!slots) { unmatched += e; continue; }
    for (const j of slots) add[j] += e / slots.length;
    spread += e;
  }
  return {
    add,
    info: {
      gasKwh: gas.kwh.reduce((a, b) => a + b, 0),
      hpKwh: add.reduce((a, b) => a + b, 0),
      unmatchedKwh: unmatched,
      spreadKwh: spread,
      unit: gas.unit,
      coveredDays: coveredDays.size,
    },
  };
}

export function heatPumpSynthetic(usage, annualKwh) {
  const wsum = new Map();
  const months = [], hours = [];
  for (const t of usage.localFloat) {
    const d = new Date(t);
    const mo = d.getUTCMonth(), hr = d.getUTCHours();
    months.push(mo); hours.push(hr);
    wsum.set(mo, (wsum.get(mo) || 0) + HP_DIURNAL[hr]);
  }
  const add = usage.localFloat.map((_, i) => {
    const share = HP_MONTHLY[months[i]] * (HP_DIURNAL[hours[i]] / wsum.get(months[i]));
    return annualKwh * share;
  });
  return { add, info: { hpKwh: add.reduce((a, b) => a + b, 0) } };
}

export function dayKeys(usage, boundary) {
  const shift = boundary === 'agile' ? 3600000 : 0;  // 23:00->23:00 local day
  return usage.localFloat.map((t) => new Date(t + shift).toISOString().slice(0, 10));
}

const PUBLISH_HHMM = '16:00';
const slotOfDay = (wall) => {
  const hh = Number(wall.slice(11, 13)), mm = Number(wall.slice(14, 16));
  return hh * 2 + (mm >= 30 ? 1 : 0);
};

// The causal loop: plan on what was knowable, execute against what actually happened.
// A plan is made at the start of the run and re-made at the start of every slot (receding
// horizon) from the current SOC and the latest forecast; the 16:00 publication extends the
// horizon to the next tariff-day. Each slot executes the plan's first step against ACTUAL
// load, so the battery follows it only as far as reality allows. Exported for tests.
export function runReplay(usage, load, imp, exp, cfg, params, pv = null) {
  const T = load.length;
  const mode = params.cycle || 'contiguous';
  const allowExport = !!params.allowExport;
  const agileKey = dayKeys(usage, 'agile');            // tariff-day (23:00-23:00)
  const calKey = usage.wall.map((w) => w.slice(0, 10));
  // end index (exclusive) of each tariff-day
  const dayEnd = new Map();
  for (let i = 0; i < T; i++) dayEnd.set(agileKey[i], i + 1);

  const fc = new Forecaster();
  const fcPv = pv ? new PvForecaster(pv) : null;
  const pvAt = (i, k) => (pv ? pv[k][i] : 0);           // k: 'ac' | 'dc'
  const slots = new Array(T);
  let soc = 0, replans = 0;
  let plan = null, planStart = 0, planMaxChgP = 0;      // plan covers [planStart, horizon)
  let horizon = dayEnd.get(agileKey[0]);
  let dayBuf = new Array(48).fill(null);                // actuals by slotOfDay
  // priceHorizon 'knownSchedule48h': a fixed time-of-use import schedule is known ahead,
  // so plan 48 h out; export beyond the published boundary is yesterday's same slot.
  // Hindsight on Agile — only honest for Go, Cosy and Flux.
  const known = params.priceHorizon === 'knownSchedule48h';
  let pubEnd = horizon;                                 // end of published export prices
  const extend = (h, i) => (known ? Math.min(T, Math.max(h, i + 96)) : h);
  const every = Math.max(1, Math.trunc(params.replanEvery || 1));

  const replanAt = (i, h) => {
    const entries = [];
    for (let t = i; t < h; t++) entries.push({ date: calKey[t], slotOfDay: slotOfDay(usage.wall[t]) });
    const loadF = fc.forecast(entries, calKey[i]);
    const expS = known
      ? exp.slice(i, h).map((v, k) => { let t = i + k; while (t >= pubEnd) t -= 48; return exp[t]; })
      : exp.slice(i, h);
    const pvF = fcPv ? fcPv.forecast(i, h, calKey) : null;
    plan = solveHorizon(soc, imp.slice(i, h), expS, loadF, cfg, mode, allowExport, pvF);
    planStart = i; horizon = h; replans++;
    // marginal refill price: the dearest slot the plan charges in. A plan that books no
    // charging (pack already full for its horizon) keeps the last booked price, so
    // load-following never treats the pack's energy as free.
    let m = 0;
    for (const t of plan.chg.keys()) m = Math.max(m, imp[i + t]);
    if (m > 0) planMaxChgP = m;
  };

  if (params.useBattery !== false) replanAt(0, extend(horizon, 0));

  for (let i = 0; i < T; i++) {
    // publication: first slot of each calendar day at/after 16:00 extends the horizon
    // to the end of the NEXT tariff-day from the NEXT slot's plan onward.
    const publishes = params.useBattery !== false &&
      usage.wall[i].slice(11, 16) >= PUBLISH_HHMM &&
      (i === 0 || usage.wall[i - 1].slice(11, 16) < PUBLISH_HHMM ||
       calKey[i - 1] !== calKey[i]);

    // execute the active plan against ACTUAL load and ACTUAL PV
    const pA = pvAt(i, 'ac'), pD = pvAt(i, 'dc');
    let cin = 0, pvcDc = 0, pvcAc = 0, dl = 0, dx = 0, plannedSoc = null, pvFc = 0;
    let room = Math.max(0, (cfg.cap - soc) / cfg.eff);                 // AC/DC-side kWh the pack can take
    if (plan && i >= planStart && i < horizon) {
      const n = i - planStart;
      // 1. PV into the pack: DC first (no inverter pass), then AC through the charge path.
      // Bounded by the ACTUAL surplus as well as the plan's: when load beats the forecast
      // the house gets the PV, or the slot would import to store energy priced at export.
      const pvcPlan = Math.min(plan.pvChg.get(n) || 0, Math.max(0, pA + pD - load[i]));
      pvcDc = Math.min(pvcPlan, pD, cfg.slotIn, room);
      pvcAc = Math.min(pvcPlan - pvcDc, pA, cfg.slotIn - pvcDc, room - pvcDc);
      plannedSoc = plan.plannedSoc[n] + cfg.reserve;
      // the day-ahead PV the plan worked from, for the chart: the forecast base at the
      // plan's issue time, without the intraday ratio — honest about lead time
      const b = fcPv ? fcPv.base(i, planStart) : null;
      pvFc = b ? b.ac + b.dc : 0;
    }
    const pvc = pvcDc + pvcAc;
    room -= pvc;
    // 2. what PV is left serves the house; the DC remainder crosses the inverter later
    let dcRest = pD - pvcDc;
    const acRest = pA - pvcAc;
    let gross = acRest + dcRest;
    let def = Math.max(0, load[i] - gross), sur = Math.max(0, gross - load[i]);
    if (plan && i >= planStart && i < horizon) {
      const n = i - planStart;
      // 3. grid charge only when nothing is being exported (one-meter rule)
      if (sur <= 1e-12) cin = Math.min(plan.chg.get(n) || 0, chargeInSlot(cfg, def), room);
      // 4. discharge: actual deficit first, then what the plan booked as export. Only the
      // booked export leaves: load the forecast over-predicted stays in the pack for a
      // later slot rather than leaving at whatever exp[i] is.
      const dd = plan.discharge.get(n);
      if (dd) {
        const q = Math.min(dd.load + dd.export, soc + (cin + pvc) * cfg.eff, cfg.slotOut);
        dl = Math.min(def, q);
        dx = allowExport ? Math.min(q - dl, dd.export, cfg.exportSlot) : 0;
      }
    }
    // 5. self-use load-following on the remaining deficit (never while charging): between
    // planned actions the inverter covers what PV did not, but only when the avoided
    // import price beats the plan's marginal refill cost (dearest planned charge,
    // pack-side). An empty pack makes this a no-op.
    const lfFloor = planMaxChgP / cfg.eff + cfg.wearP;
    if (cin <= 1e-12 && pvc <= 1e-12 && imp[i] > lfFloor + 1e-9) {
      const extra = Math.min(def - dl, soc - dl - dx, cfg.slotOut - dl - dx);
      if (extra > 1e-12) dl += extra;
    }
    // 6. DC coupling: PV that is not charging shares the inverter's AC output with
    // discharge. The overflow comes off battery export FIRST, then off discharge to the
    // house — the inverter's AC output is the same either way, so the house is served
    // identically, but PV passes through in place of stored energy and the pack keeps
    // it (worth >= 0 later, while clipped PV is gone for good). Only when both are
    // exhausted does the remainder clip the PV.
    let over = Math.max(0, dcRest + dl + dx - cfg.slotOut);
    const trim = Math.min(dx, over);
    dx -= trim; over -= trim;
    const back = Math.min(dl, over);
    dl -= back; over -= back;
    const dcClip = over;
    dcRest -= dcClip; gross = acRest + dcRest;
    def = Math.max(0, load[i] - gross); sur = Math.max(0, gross - load[i]);   // dl <= old def <= new def
    // the clip re-exposes deficit PV was covering. Serve it from the pack's booked export
    // instead of importing and exporting in the same half-hour: the pack-side total is
    // unchanged, so the inverter cap and the SOC trajectory still hold. A no-op without a
    // clip: step 4 leaves dx > 0 only where dl already covers the whole deficit.
    const shift = Math.min(def - dl, dx);
    if (shift > 1e-12) { dl += shift; dx -= shift; }
    // 7. PV surplus takes the connection's export capacity first: free PV that would
    // otherwise be spilled beats stored energy, which keeps its value in the pack. What
    // the battery does not export simply is not removed from soc.
    const pvx = allowExport ? Math.min(sur, cfg.exportCap) : 0;
    dx = Math.min(dx, Math.max(0, cfg.exportCap - pvx));
    const spill = sur - pvx + dcClip;
    soc += (cin + pvc) * cfg.eff - dl - dx;

    slots[i] = { i, cin, pvc, dl, dx, pvx, spill, soc, plannedSoc, pvFc,
                 def, pvHouse: Math.min(load[i], gross) };

    // settle: forecaster learns the actual, day buffer fills
    const sd = slotOfDay(usage.wall[i]);
    fc.settle(calKey[i], sd, load[i]);
    if (fcPv) fcPv.settle(i);
    dayBuf[sd] = dayBuf[sd] === null ? load[i] : (dayBuf[sd] + load[i]) / 2;  // DST repeat: average
    const dayDone = i + 1 === T || calKey[i + 1] !== calKey[i];
    if (dayDone) {
      fc.completeDay(calKey[i], dayBuf); dayBuf = new Array(48).fill(null);
      if (fcPv) fcPv.completeDay();
    }

    // Receding horizon: re-plan at the start of every slot (or every `replanEvery`
    // slots; publication and plan expiry always replan) from the current SOC and the
    // forecast as it now stands. Publication extends the horizon to the end of the NEXT
    // tariff-day; otherwise the standing horizon (prices already published) is kept.
    if (params.useBattery !== false && i + 1 < T) {
      let h = horizon;
      if (publishes) {
        const next = dayEnd.get(agileKey[Math.min(dayEnd.get(agileKey[i]), T - 1)]) ?? T;
        h = Math.max(next, dayEnd.get(agileKey[i]));
        pubEnd = Math.max(pubEnd, h);
      }
      if (publishes || i + 1 >= horizon || (i + 1 - planStart) % every === 0) {
        replanAt(i + 1, extend(h, i + 1));
      }
    }
  }
  return { slots, replans, warmupDays: FORECAST_DEFAULTS.warmupDays };
}

// params.boundary is ignored: the replay's horizons come from the tariff day and the
// 16:00 publication, not from a user-chosen window boundary.
export function runSim({ usage, load, imp, exp, scTotalP, params, pv = null }) {
  const cfg = makeCfg(params);
  const { slots: exec, replans, warmupDays } = runReplay(usage, load, imp, exp, cfg, params, pv);

  // presentation is always calendar days: costs are per-slot, so any grouping sums exactly
  const slots = new Array(load.length);
  const byDate = new Map();
  let maxExportSlot = 0, violations = 0;
  const allowX = !!params.allowExport;

  for (let i = 0; i < load.length; i++) {
    const { cin, pvc, dl, dx, pvx, spill, soc, plannedSoc, pvFc, def, pvHouse } = exec[i];
    if (soc < -1e-6 || soc > cfg.cap + 1e-6) violations++;
    const gImp = def + cin - dl;                       // deficit after PV, plus grid charge, less discharge
    const gExp = dx + pvx;
    const slotP = gImp * imp[i] - gExp * exp[i];
    // no-battery baseline: PV serves the house, surplus exports under the cap (DC clipped by the inverter)
    const pvOnly = pv ? Math.min(load[i], pv.ac[i] + Math.min(pv.dc[i], cfg.slotOut)) : 0;
    const pvOnlyExp = pv && allowX ? Math.min(pv.ac[i] + Math.min(pv.dc[i], cfg.slotOut) - pvOnly, cfg.exportCap) : 0;
    const baseSlotP = (load[i] - pvOnly) * imp[i] - pvOnlyExp * exp[i];
    maxExportSlot = Math.max(maxExportSlot, gExp);
    const date = usage.wall[i].slice(0, 10);
    const hhmm = usage.wall[i].slice(11);
    let d = byDate.get(date);
    if (!d) {
      d = { day: date, kwh: 0, baseP: 0, costP: 0, kwhOut: 0, pv: 0, w0: null, w1: null };
      byDate.set(date, d);
    }
    d.kwh += load[i];
    d.baseP += baseSlotP;
    d.pv += pv ? pv.ac[i] + pv.dc[i] : 0;
    d.costP += slotP;
    d.kwhOut += dl + dx;
    if (cin > 1e-9) {
      if (d.w0 === null) d.w0 = hhmm;
      d.w1 = hhmm;
    }
    slots[i] = {
      day: date, wall: usage.wall[i], hhmm,
      imp: imp[i], exp: exp[i], load: load[i], chg: cin,
      disLoad: dl, disExp: dx,
      pvGen: pv ? pv.ac[i] + pv.dc[i] : 0, pvToHouse: pvHouse,
      pvToBattery: pvc, pvExport: pvx, pvSpill: spill,
      gridImp: Math.max(0, gImp), gridExp: gExp,
      gridToHouse: Math.max(0, def - dl),
      soc: Math.max(0, soc) + cfg.reserve,
      socPct: cfg.cap + cfg.reserve
        ? 100 * (Math.max(0, soc) + cfg.reserve) / (cfg.cap + cfg.reserve) : 0,
      plannedSoc, pvFc,
      costP: slotP,
    };
  }
  const perDay = [...byDate.values()].map((d) => ({
    day: d.day, kwh: d.kwh, baseP: d.baseP, costP: d.costP,
    savedP: d.baseP - d.costP, kwhOut: d.kwhOut, pv: d.pv,
    window: d.w0 !== null ? [d.w0, d.w1] : null,
    used: d.kwhOut > 1e-9,
  }));

  const energy = perDay.reduce((a, d) => a + d.costP, 0) / 100;
  // pack-kWh charged: PV cycles the pack exactly as grid import does, so both wear it
  const stored = exec.reduce((a, s) => a + s.cin + s.pvc, 0) * cfg.eff;
  const wear = stored * cfg.wearP / 100;                             // £, not in `energy`
  const baseline = perDay.reduce((a, d) => a + d.baseP, 0) / 100;
  const cycled = perDay.reduce((a, d) => a + d.kwhOut, 0);
  const nDays = load.length / 48;
  return {
    energy, baseline, sc: scTotalP / 100,
    total: energy + scTotalP / 100,
    baselineTotal: baseline + scTotalP / 100,
    savedVsNoBattery: baseline - energy,
    kwh: load.reduce((a, b) => a + b, 0),
    nDays, slotCount: load.length,
    cycled, usableCap: cfg.cap,
    batteryDays: perDay.filter((d) => d.used).length, dayCount: perDay.length,
    meanThroughput: cycled / Math.max(1, perDay.length),
    utilisation: 100 * (cycled / Math.max(1, perDay.length)) / cfg.cap,
    maxExportSlot, socViolations: violations,
    wear, wearP: cfg.wearP, stored,
    pvKwh: slots.reduce((a, s) => a + s.pvGen, 0),
    pvToHouse: slots.reduce((a, s) => a + s.pvToHouse, 0),
    pvToBattery: slots.reduce((a, s) => a + s.pvToBattery, 0),
    pvExport: slots.reduce((a, s) => a + s.pvExport, 0),
    pvSpill: slots.reduce((a, s) => a + s.pvSpill, 0),
    warmupDays, replans,
    perDay, slots,
  };
}

// Octopus usage exports normally carry "Estimated Cost Inc. Tax (p)" and "Standing Charge
// Inc. Tax (p)", which is where the current-tariff comparison comes from. Not every export
// (or supplier) includes them, hence the manual override.
export function currentTariffTotal(usage, extraLoad, override) {
  const kwh = usage.kwh.reduce((a, b) => a + b, 0);
  const csvEnergyP = usage.actualP.reduce((a, b) => a + b, 0);
  const csvScP = usage.scP.reduce((a, b) => a + b, 0);
  const hasCsvCost = csvEnergyP > 0;
  const hasCsvSc = csvScP > 0;
  const extraKwh = extraLoad ? extraLoad.reduce((a, b) => a + b, 0) : 0;
  const days = usage.kwh.length / 48;

  if (override && override.unitRateP !== null && override.unitRateP !== undefined) {
    const rate = override.unitRateP;
    const scP = (override.scPerDayP || 0) * days;
    const energyP = (kwh + extraKwh) * rate;
    return { energy: energyP / 100, sc: scP / 100, total: (energyP + scP) / 100,
             impliedRate: rate, source: 'manual', hasCsvCost, hasCsvSc };
  }
  // value any added heat pump load at the file's own implied unit rate
  const rate = kwh > 0 ? csvEnergyP / kwh : 0;
  const energyP = csvEnergyP + extraKwh * rate;
  return { energy: energyP / 100, sc: csvScP / 100, total: (energyP + csvScP) / 100,
           impliedRate: rate, source: 'csv', hasCsvCost, hasCsvSc };
}

// Repay time in years when the yearly saving grows escPct %/yr: cumulative saving
// through year n is S·((1+e)^n − 1)/e; solve for the crossing with the cost.
export const paybackYears = (cost, savePerYear, escPct = 0) => {
  if (!(cost > 0) || !(savePerYear > 0)) return null;
  const e = (escPct || 0) / 100;
  if (e === 0) return cost / savePerYear;
  // valid for -1 < e too (falling prices): x <= 0 means the escalating/deflating
  // saving never accumulates to the cost, so there's no crossing -> null.
  const x = 1 + cost * e / savePerYear;
  return x > 0 ? Math.log(x) / Math.log(1 + e) : null;
};

// Return over the battery's life: savings accumulated over `years` at the escalation rate
// (same geometric form as paybackYears, so the two agree: the return at the payback year
// is zero), less the cost. null without a positive cost or a usable lifespan.
export function lifetimeReturn(cost, savePerYear, years, escPct = 0) {
  if (!(cost > 0) || !(years > 0) || !Number.isFinite(years) || !Number.isFinite(savePerYear)) return null;
  const e = (escPct || 0) / 100;
  const saved = e === 0 ? savePerYear * years : savePerYear * (Math.pow(1 + e, years) - 1) / e;
  return { saved, net: saved - cost, pct: (saved - cost) / cost * 100 };
}

// £ the gas meter cost over the CSV window: matched gas kWh at the unit rate plus the
// standing charge. Matched = metered minus the kWh that fell outside the electricity
// date range (heatPumpFromGas already reports both). No gas data or no rate -> 0;
// the caller is responsible for warning that the credit is missing.
export function gasBillPounds(hpInfo, unitRateP, scPerDayP, nDays) {
  if (!hpInfo || hpInfo.gasKwh === undefined || !(unitRateP > 0)) return 0;
  const matched = Math.max(0, hpInfo.gasKwh - hpInfo.unmatchedKwh);
  return (matched * unitRateP + (scPerDayP || 0) * nDays) / 100;
}

// Sensitivity-sweep grids. Capacity sweeps relative to the configured pack; inverter
// sweeps a fixed ladder of common hybrid sizes plus the configured one.
export const sweepCapacities = (cap) =>
  [...new Set([0.5, 0.625, 0.75, 0.875, 1, 1.125, 1.25]
    .map((m) => Math.round(cap * m * 10) / 10)
    // drop grid entries too close to the raw value -- else a non-0.1-aligned cap
    // produces an adjacent near-duplicate row and the marginal columns divide by
    // that tiny gap, amplifying solver noise
    .filter((v) => Math.abs(v - cap) > cap * 0.02)
    .concat([cap]))].sort((a, b) => a - b);
export const sweepInverters = (kw) =>
  [...new Set([3.6, 5, 6, 8, 10, 12, kw])].sort((a, b) => a - b);

// Predicted max allowed export from supply voltage rise: exporting I through the
// network's source impedance lifts the terminals by I·Z, and the DNO must keep the
// point of connection inside the 253 V statutory cap (230 V +10%). At the cap the
// terminals sit at vMax, so I = (vMax − sourceV)/Z and P = vMax·I. An estimate of
// the physics ceiling a G99 study works to — the DNO may grant less (shared feeder).
export function predictedExportKw(sourceV, sourceOhms, vMax = 253) {
  if (!Number.isFinite(sourceV) || !Number.isFinite(sourceOhms)
      || sourceV <= 0 || sourceOhms <= 0) return null;
  if (sourceV >= vMax) return 0;
  return vMax * (vMax - sourceV) / sourceOhms / 1000;
}

// Day-chart hit test: which slot owns viewBox x-coordinate sx. Slots tile
// [L, R] evenly; out-of-plot coordinates clamp to the nearest end slot.
export function slotAtX(sx, n, L = 40, R = 460) {
  if (!n) return null;
  return Math.max(0, Math.min(n - 1, Math.floor((sx - L) / ((R - L) / n))));
}

// Simple year-1 return on the outlay: annual saving over capex, as %/yr.
// The reciprocal of unescalated payback — comparable to an interest rate.
// Negative savings report a negative return rather than hiding it.
export function roiPct(cost, savePerYear) {
  if (!(cost > 0) || !Number.isFinite(savePerYear)) return null;
  return savePerYear / cost * 100;
}
