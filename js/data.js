// Octopus usage CSVs carry the local wall clock WITH its offset ("2025-08-04T00:00:00+01:00"),
// so wall clock comes from the string and the UTC instant from Date.parse — no timezone
// library needed, and correct across both DST changeovers.

import { makeCfg, solveDay } from './optimiser.js';

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

// Fixed point: re-cut at each group's first charging slot until stable (~3 iterations).
// Must match test/adaptive_boundary.py solve_groups exactly — test/cycle.mjs asserts it.
export function cycleEdges(imp, exp, load, cfg, mode, allowExport, initialEdges, maxIter = 12) {
  const T = load.length;
  let edges = initialEdges;
  let prevKey = null;
  for (let it = 0; it < maxIter; it++) {
    const starts = [];
    for (let g = 0; g < edges.length - 1; g++) {
      const a = edges[g], b = edges[g + 1];
      if (b - a < 2) continue;
      const r = solveDay(imp.slice(a, b), exp.slice(a, b), load.slice(a, b),
                         cfg, mode, allowExport);
      if (r.charge.size) starts.push(a + Math.min(...r.charge.keys()));
    }
    const key = starts.join(',');
    if (key === prevKey) break;
    prevKey = key;
    edges = [...new Set([0, ...starts.filter((s) => s > 0 && s < T), T])]
      .sort((x, y) => x - y);
  }
  return edges;
}

// Hold pass: at each window boundary, energy the outgoing window would dump into its
// cheapest discharge slots is carried forward instead whenever the next window values it
// higher — serving load before its discharge phase (bridging) or displacing its dearest
// refill kWh. Mirrors test/pymodel.py hold_pass exactly (asserted by test/hold.mjs).
const HEPS = 1e-9, HMARGIN = 1e-6;
export function holdPass(sols, imp, exp, load, cfg) {
  const held = new Array(sols.length).fill(0);
  for (let g = 0; g < sols.length - 1; g++) {
    const w = sols[g], w1 = sols[g + 1];
    const dis = w.r.discharge;
    let lastChg = -1;
    for (const n of w.r.charge.keys()) lastChg = Math.max(lastChg, n);
    const unw = [];
    for (const [n, dd] of dis) {
      // only tail discharge: unwinding pre-fill bridging would leave inbound energy
      // in the pack when the fill lands, overflowing capacity
      if (n <= lastChg) continue;
      const t = w.a + n;
      if (dd.export > HEPS) unw.push([exp[t], n, dd.export, 'export']);
      if (dd.load > HEPS) unw.push([imp[t], n, dd.load, 'load']);
    }
    if (!unw.length) continue;
    unw.sort((x, y) => x[0] - y[0]);

    const a1 = w1.a;
    const chg1 = w1.r.charge, dis1 = w1.r.discharge;
    const s1 = dis1.size ? Math.min(...dis1.keys()) : (w1.b - a1);
    const cand = [];
    for (let n = 0; n < s1; n++) {
      const t = a1 + n;
      if ((chg1.get(n) || 0) <= HEPS && load[t] > HEPS) {
        cand.push([imp[t], n, Math.min(load[t], cfg.slotOut), 'load']);
      }
    }
    for (const [n, c] of chg1) cand.push([imp[a1 + n] / cfg.eff, n, c * cfg.eff, 'fill']);
    cand.sort((x, y) => y[0] - x[0]);

    let plan = [], K = 0, ui = 0;
    for (const [v, n, q0, kind] of cand) {
      let q = q0;
      while (q > HEPS && ui < unw.length) {
        const u = unw[ui];
        if (u[0] >= v - HMARGIN) { q = -1; break; }
        const take = Math.min(q, u[2]);
        plan.push([take, u, n, kind, v]);
        u[2] -= take; q -= take; K += take;
        if (u[2] <= HEPS) ui++;
      }
      if (q < 0 || ui >= unw.length) break;
    }
    if (K <= HEPS) continue;

    // capacity feasibility with the inbound energy; drop cheapest bridging items on overflow
    for (;;) {
      const addL = new Map(), cutF = new Map();
      let kIn = 0;
      for (const [take, , n, kind] of plan) {
        kIn += take;
        if (kind === 'load') addL.set(n, (addL.get(n) || 0) + take);
        else cutF.set(n, (cutF.get(n) || 0) + take);
      }
      let soc = kIn, ok = true;
      for (let n = 0; n < w1.b - a1; n++) {
        soc += ((chg1.get(n) || 0) - (cutF.get(n) || 0) / cfg.eff) * cfg.eff;
        const dd = dis1.get(n);
        if (dd) soc -= dd.load + dd.export;
        soc -= addL.get(n) || 0;
        if (soc > cfg.cap + 1e-6) { ok = false; break; }
      }
      if (ok) break;
      let di = -1;
      for (let i = 0; i < plan.length; i++) {
        if (plan[i][3] === 'load' && (di < 0 || plan[i][4] < plan[di][4])) di = i;
      }
      if (di < 0) { plan = []; break; }
      plan.splice(di, 1);
    }
    if (!plan.length) continue;

    let k = 0;
    for (const [take, u, n, kind] of plan) {
      const dd = dis.get(u[1]);
      dd[u[3]] -= take;
      if (kind === 'load') {
        let dd1 = dis1.get(n);
        if (!dd1) { dd1 = { load: 0, export: 0 }; dis1.set(n, dd1); }
        dd1.load += take;
      } else {
        const c = chg1.get(n) - take / cfg.eff;
        if (c <= HEPS) chg1.delete(n); else chg1.set(n, c);
      }
      k += take;
    }
    held[g + 1] = k;
  }
  return held;
}

export function runSim({ usage, load, imp, exp, scTotalP, params }) {
  const cfg = makeCfg(params);
  const mode = params.cycle || 'scattered';
  const allowExport = !!params.allowExport;
  const useBattery = params.useBattery !== false;

  const groupList = [];
  if (params.boundary === 'cycle' && useBattery) {
    const midKeys = dayKeys(usage, 'midnight');
    const initial = [0];
    for (let i = 1; i < load.length; i++) if (midKeys[i] !== midKeys[i - 1]) initial.push(i);
    initial.push(load.length);
    const edges = cycleEdges(imp, exp, load, cfg, mode, allowExport, initial);
    const seen = new Set();
    for (let g = 0; g < edges.length - 1; g++) {
      let k = usage.wall[edges[g]];
      while (seen.has(k)) k += '·';   // DST repeat hour could duplicate a wall string
      seen.add(k);
      const ix = [];
      for (let i = edges[g]; i < edges[g + 1]; i++) ix.push(i);
      groupList.push({ k, ix });
    }
  } else {
    const keys = dayKeys(usage, params.boundary === 'cycle' ? 'midnight' : params.boundary);
    const groups = new Map();
    keys.forEach((k, i) => {
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(i);
    });
    for (const k of [...groups.keys()].sort()) groupList.push({ k, ix: groups.get(k) });
  }

  const sols = groupList.map(({ k, ix }) => {
    const r = useBattery
      ? solveDay(ix.map((i) => imp[i]), ix.map((i) => exp[i]), ix.map((i) => load[i]),
                 cfg, mode, allowExport)
      : { profit: 0, charge: new Map(), discharge: new Map(), kwhOut: 0, window: null };
    return { k, ix, a: ix[0], b: ix[0] + ix.length, r };
  });
  const held = useBattery ? holdPass(sols, imp, exp, load, cfg)
                          : new Array(sols.length).fill(0);

  // presentation is always calendar days, whatever windows the strategy solved on:
  // costs are per-slot, so any grouping sums exactly
  const slots = new Array(load.length);
  const byDate = new Map();
  let maxExportSlot = 0, violations = 0, soc = 0;

  for (const { ix, r } of sols) {
    for (let n = 0; n < ix.length; n++) {
      const i = ix[n];
      const cin = r.charge.get(n) || 0;
      const dd = r.discharge.get(n) || { load: 0, export: 0 };
      soc += cin * cfg.eff - dd.load - dd.export;
      if (soc < -1e-6 || soc > cfg.cap + 1e-6) violations++;
      const gImp = load[i] + cin - dd.load;
      const slotP = gImp * imp[i] - dd.export * exp[i];
      maxExportSlot = Math.max(maxExportSlot, dd.export);
      const date = usage.wall[i].slice(0, 10);
      const hhmm = usage.wall[i].slice(11);
      let d = byDate.get(date);
      if (!d) {
        d = { day: date, kwh: 0, baseP: 0, costP: 0, kwhOut: 0, w0: null, w1: null };
        byDate.set(date, d);
      }
      d.kwh += load[i];
      d.baseP += load[i] * imp[i];
      d.costP += slotP;
      d.kwhOut += dd.load + dd.export;
      if (cin > 1e-9) {
        if (d.w0 === null) d.w0 = hhmm;
        d.w1 = hhmm;
      }
      slots[i] = {
        day: date, wall: usage.wall[i], hhmm,
        imp: imp[i], exp: exp[i], load: load[i], chg: cin,
        disLoad: dd.load, disExp: dd.export,
        gridImp: Math.max(0, gImp), gridExp: dd.export,
        gridToHouse: Math.max(0, load[i] - dd.load),
        soc: Math.max(0, soc) + cfg.reserve,
        socPct: cfg.cap + cfg.reserve
          ? 100 * (Math.max(0, soc) + cfg.reserve) / (cfg.cap + cfg.reserve) : 0,
        costP: slotP,
      };
    }
  }
  const perDay = [...byDate.values()].map((d) => ({
    day: d.day, kwh: d.kwh, baseP: d.baseP, costP: d.costP,
    savedP: d.baseP - d.costP, kwhOut: d.kwhOut,
    window: d.w0 !== null ? [d.w0, d.w1] : null,
    used: d.kwhOut > 1e-9,
  }));
  const carried = held.reduce((a, b) => a + b, 0);

  const energy = perDay.reduce((a, d) => a + d.costP, 0) / 100;
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
    cycled, carried, usableCap: cfg.cap,
    batteryDays: perDay.filter((d) => d.used).length, dayCount: perDay.length,
    meanThroughput: cycled / Math.max(1, perDay.length),
    utilisation: 100 * (cycled / Math.max(1, perDay.length)) / cfg.cap,
    maxExportSlot, socViolations: violations,
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
