// Shared optimiser primitives: config derivation, per-slot charge room, and the
// discharge-value bucket machinery the causal planner (js/causal.js) builds on.
// Model in README.md. Energy balance is load-bearing: without it the optimiser charges
// through negative-price slots just to collect the payment and lets the energy evaporate.

export function makeCfg(p) {
  const invSlot = p.inverterKw * 0.5;
  // discharge floor: the bottom N% is never cycled, so the solver works entirely in
  // the usable band above it and the reserve only reappears in displayed soc
  const floor = p.dischargeFloorPct ? Math.min(Math.max(p.dischargeFloorPct, 0), 95) / 100 : 0;
  return {
    cap: p.capacity * (1 - floor),
    reserve: p.capacity * floor,
    eff: p.roundTrip,
    slotIn: invSlot,
    slotOut: invSlot,
    chgStep: invSlot * p.roundTrip,
    // cap TOTAL grid import (load + charge) rather than just battery charge
    importCap: p.totalImportLimitKw ? p.totalImportLimitKw * 0.5 : null,
    // only charge in slots at or below this price
    maxChgP: (p.maxChargePrice === null || p.maxChargePrice === undefined ||
              p.maxChargePrice === '') ? Infinity : Number(p.maxChargePrice),
    // G100 export limitation: cap export power independently of inverter size
    exportSlot: p.exportLimitKw ? p.exportLimitKw * 0.5 : invSlot,
  };
}

export function chargeInSlot(cfg, loadT) {
  if (cfg.importCap === null) return cfg.slotIn;
  return Math.max(0, Math.min(cfg.slotIn, cfg.importCap - loadT));
}

// Marginal value of discharging, slots s..end, best first, per-slot cap applied.
// Value of 1 kWh into load = the import price it avoids; into export = the export price.
export function dischargeBuckets(imp, exp, load, s, allowExport, cfg) {
  const raw = [];
  for (let t = s; t < imp.length; t++) {
    const lq = Math.min(load[t], cfg.slotOut);
    raw.push({ val: imp[t], qty: lq, t, kind: 'load' });
    if (allowExport) {
      // net settlement: when export pays more than import, output still offsets the
      // slot's own load first — a single meter cannot settle both directions at once
      const room = exp[t] > imp[t] ? cfg.slotOut - lq : cfg.slotOut;
      raw.push({ val: exp[t], qty: Math.min(room, cfg.exportSlot), t, kind: 'export' });
    }
  }
  // stable sort by descending value, matching Python's stable sort on -value
  raw.sort((a, b) => b.val - a.val);
  const rem = new Map();
  const out = [];
  for (const b of raw) {
    const cap = rem.has(b.t) ? rem.get(b.t) : cfg.slotOut;
    const q = Math.min(b.qty, cap);
    if (q <= 1e-12) continue;
    rem.set(b.t, cap - q);
    out.push({ val: b.val, qty: q, t: b.t, kind: b.kind });
  }
  return out;
}

// Cumulative (qty, value) over ALL buckets, best first. Not truncated at value<=0:
// under energy balance, charged energy must go somewhere even if that slot pays little.
export function cumAll(buckets) {
  const qs = [0], vs = [0];
  for (const b of buckets) {
    qs.push(qs[qs.length - 1] + b.qty);
    vs.push(vs[vs.length - 1] + b.val * b.qty);
  }
  return { qs, vs };
}

// Value of discharging exactly E kWh, or null if the window cannot absorb E.
export function valueFor(cum, E) {
  const { qs, vs } = cum;
  if (E <= 0) return 0;
  if (E > qs[qs.length - 1] + 1e-9) return null;
  for (let i = 1; i < qs.length; i++) {
    if (qs[i] >= E - 1e-12) {
      const span = qs[i] - qs[i - 1];
      const frac = span > 1e-12 ? (E - qs[i - 1]) / span : 0;
      return vs[i - 1] + (vs[i] - vs[i - 1]) * frac;
    }
  }
  return vs[vs.length - 1];
}

export function takeDischarge(buckets, E) {
  let left = E, got = 0;
  const alloc = new Map();
  for (const b of buckets) {
    if (left <= 1e-12) break;
    const x = Math.min(b.qty, left);
    if (!alloc.has(b.t)) alloc.set(b.t, { load: 0, export: 0 });
    alloc.get(b.t)[b.kind] += x;
    got += b.val * x;
    left -= x;
  }
  return { got, alloc };
}
