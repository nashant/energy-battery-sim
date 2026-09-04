// Solar arrays: postcode -> site, per-array irradiance fetch (Open-Meteo, cached), and the
// half-hourly kWh series the engine consumes. Everything except fetchArray is pure.
// Open-Meteo azimuth: 0 = south, -90 = east, +90 = west. Radiation values are averages over
// the PRECEDING interval, so a label at T describes [T - step, T).

import { cacheGet, cachePut } from './tariffs.js';

export const bearingToAzimuth = (bearing) => {
  const a = ((((bearing - 180) % 360) + 540) % 360) - 180;   // (-180, 180]
  return a === -180 ? 180 : a;
};

export function toHalfHours(times, values, stepMin) {
  const out = new Map();
  const step = stepMin * 60000;
  for (let k = 0; k < times.length; k++) {
    const end = Date.parse(times[k] + (times[k].endsWith('Z') ? '' : 'Z'));
    const v = values[k] ?? 0;
    if (stepMin === 60) {
      out.set(end - 3600000, v);
      out.set(end - 1800000, v);
    } else {
      // the quarter [end-15, end) lies in the half hour starting at floor((end-1)/30min)
      const hh = Math.floor((end - 1) / 1800000) * 1800000;
      const prev = out.get(hh);
      out.set(hh, prev === undefined ? v / 2 : prev + v / 2);   // two quarters per half hour
    }
  }
  return out;
}

export function alignToUsage(map, instants) {
  const values = new Array(instants.length);
  let filled = 0, missing = 0;
  for (let i = 0; i < instants.length; i++) {
    const t = instants[i];
    let v = map.get(t);
    if (v === undefined) { v = map.get(t - 3600000); if (v !== undefined) filled++; }
    if (v === undefined) { v = 0; missing++; }
    values[i] = v;
  }
  return { values, filled, missing };
}

export function arrayKwh(gti, arr) {
  const derate = 1 - (arr.lossPct ?? 14) / 100;
  // anything not explicitly DC is AC — the same rule sumArrays buckets by, so a
  // malformed coupling is clipped by the inverter it is summed under
  const cap = arr.coupling !== 'dc' && arr.inverterKw > 0 ? arr.inverterKw * 0.5 : Infinity;
  return gti.map((w) => Math.min(cap, (w || 0) * 0.5 / 1000 * arr.kwp * derate));
}

export function sumArrays(perArray, T) {
  const s = { ac: new Float64Array(T), dc: new Float64Array(T), acF1: new Float64Array(T),
              acF2: new Float64Array(T), dcF1: new Float64Array(T), dcF2: new Float64Array(T) };
  for (const { arr, actual, f1, f2 } of perArray) {
    const [a, b, c] = arr.coupling === 'dc' ? ['dc', 'dcF1', 'dcF2'] : ['ac', 'acF1', 'acF2'];
    for (let t = 0; t < T; t++) { s[a][t] += actual[t]; s[b][t] += f1[t]; s[c][t] += f2[t]; }
  }
  return s;
}

// ---------------------------------------------------------------- network

const HIST = 'https://historical-forecast-api.open-meteo.com/v1/forecast';
const PREV = 'https://previous-runs-api.open-meteo.com/v1/forecast';

export async function lookupPostcode(postcode, fetchFn = fetch) {
  const pc = postcode.replace(/\s+/g, '').toUpperCase();
  const r = await fetchFn(`https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`);
  if (!r.ok) throw new Error(`Postcode lookup failed (${r.status}) for ${postcode}`);
  const j = await r.json();
  return { lat: j.result.latitude, lon: j.result.longitude, postcode: j.result.postcode };
}

async function cachedJson(key, url, fetchFn, onProgress) {
  const hit = await cacheGet(key);
  if (hit) return hit;
  if (onProgress) onProgress(`fetching ${key.split('|')[0]}…`);
  const r = await fetchFn(url);
  if (!r.ok) throw new Error(`Open-Meteo ${r.status} for ${url.slice(0, 60)}…`);
  const j = await r.json();
  await cachePut(key, j);
  return j;
}

// Actual (UK 2 km short-range archive, 15-minutely) and day-ahead / two-day-ahead forecasts
// (previous runs, hourly) for one array's plane, over [startDate, endDate] inclusive (YYYY-MM-DD).
export async function fetchPlane({ lat, lon, tilt, azimuth, startDate, endDate }, fetchFn = fetch, onProgress) {
  const site = `${lat.toFixed(4)}|${lon.toFixed(4)}|${tilt}|${azimuth}|${startDate}|${endDate}`;
  const common = `latitude=${lat}&longitude=${lon}&start_date=${startDate}&end_date=${endDate}` +
                 `&timezone=UTC&tilt=${tilt}&azimuth=${azimuth}`;
  const act = await cachedJson(`pv:actual|${site}`,
    `${HIST}?${common}&minutely_15=global_tilted_irradiance&models=best_match`, fetchFn, onProgress);
  const fc = await cachedJson(`pv:forecast|${site}`,
    `${PREV}?${common}&hourly=global_tilted_irradiance_previous_day1,global_tilted_irradiance_previous_day2`,
    fetchFn, onProgress);
  return {
    actual: toHalfHours(act.minutely_15.time, act.minutely_15.global_tilted_irradiance, 15),
    f1: toHalfHours(fc.hourly.time, fc.hourly.global_tilted_irradiance_previous_day1, 60),
    f2: toHalfHours(fc.hourly.time, fc.hourly.global_tilted_irradiance_previous_day2, 60),
  };
}

// The whole pipeline for a site and its arrays against a parsed usage CSV. Returns the six
// engine series plus per-array annual kWh and alignment counts for the UI.
export async function buildPv(usage, site, arrays, fetchFn = fetch, onProgress) {
  const startDate = new Date(usage.utc[0]).toISOString().slice(0, 10);
  const endDate = new Date(usage.utc[usage.utc.length - 1]).toISOString().slice(0, 10);
  const perArray = [];
  for (const arr of arrays) {
    const plane = await fetchPlane({ lat: site.lat, lon: site.lon, tilt: arr.tilt,
                                     azimuth: bearingToAzimuth(arr.bearing), startDate, endDate }, fetchFn,
                                   onProgress && ((m) => onProgress(`${arr.name || 'array'}: ${m}`)));
    const a = alignToUsage(plane.actual, usage.utc), b = alignToUsage(plane.f1, usage.utc), c = alignToUsage(plane.f2, usage.utc);
    const actual = arrayKwh(a.values, arr), f1 = arrayKwh(b.values, arr), f2 = arrayKwh(c.values, arr);
    perArray.push({ arr, actual, f1, f2, kwh: actual.reduce((x, y) => x + y, 0),
                    missing: a.missing, filled: a.filled });
  }
  return { series: sumArrays(perArray, usage.utc.length), perArray };
}
