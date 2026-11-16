// Octopus product registry + rate fetching, cached in IndexedDB.
// Rates are keyed by UTC instant, which makes the DST changeovers unambiguous -- the
// repeated autumn hour and the missing spring hour are both exact instants.

const BASE = 'https://api.octopus.energy/v1/products';
const FAR_FUTURE = 4102444800000; // 2100-01-01

export const REGIONS = {
  A: 'Eastern England', B: 'East Midlands', C: 'London', D: 'Merseyside & N Wales',
  E: 'West Midlands', F: 'North East', G: 'North West', H: 'Southern England',
  J: 'South East England', K: 'South Wales', L: 'South West England', M: 'Yorkshire',
  N: 'South Scotland', P: 'North Scotland',
};

// exports: the export tariffs Octopus permits with each import, default first, per the
// Smart Tariffs T&Cs (https://octopus.energy/policies/smart-tariffs-terms-and-condition/).
// latest: a fixed time-of-day tariff, priced at today's rates for the whole period -- the
// question is what the tariff would cost from now on, not what it cost last year. The Agile
// pair has no "today's rate" to project, so it stays on its real half-hourly history.
export const IMPORT_TARIFFS = {
  agile: {
    code: 'AGILE-24-10-01', name: 'Agile Octopus',
    note: 'Half-hourly wholesale-tracking prices published day-ahead. No eligibility gate.',
    exports: ['agile-outgoing', 'outgoing-var', 'prime', 'seg', 'flat', 'none'],
  },
  go: {
    code: 'GO-VAR-22-10-14', name: 'Octopus Go', latest: true,
    note: 'Cheap 00:30–05:30, flat day rate. Designed for customers with an EV or plug-in ' +
          'hybrid charged at home (Smart Tariffs T&Cs §2.1.3) — Octopus can move you to ' +
          'another tariff if you do not have one. ' +
          'Pairs only with Outgoing SEG, Outgoing Octopus or Agile Outgoing (§2.1.2).',
    exports: ['none', 'seg', 'outgoing-var', 'agile-outgoing', 'flat'],
  },
  flux: {
    code: 'FLUX-IMPORT-23-02-14', name: 'Octopus Flux (import)', latest: true,
    note: 'For solar + battery owners. Cheap overnight, peak 16:00–19:00. A combined ' +
          'import/export tariff: Flux Export is the only export allowed (§2.7.1).',
    exports: ['flux-export'],
  },
  cosy: {
    code: 'COSY-22-12-08', name: 'Cosy Octopus', latest: true,
    note: 'Cheap 04:00–07:00, 13:00–16:00, 22:00–00:00; peak 16:00–19:00. Needs a heat pump, ' +
          'electric boiler or electric radiators. Pairs only with Outgoing SEG, Outgoing ' +
          'Octopus or Agile Outgoing (§2.6.2).',
    exports: ['agile-outgoing', 'outgoing-var', 'seg', 'flat', 'none'],
  },
};

export const EXPORT_TARIFFS = {
  none: { code: null, name: 'No export tariff' },
  'agile-outgoing': { code: 'AGILE-OUTGOING-19-05-13', name: 'Agile Outgoing (half-hourly)' },
  'outgoing-var': { code: 'OUTGOING-VAR-24-10-26', name: 'Outgoing Octopus (flat)', latest: true },
  'flux-export': { code: 'FLUX-EXPORT-23-02-14', name: 'Flux Export', latest: true },
  prime: {
    code: 'OUTGOING-PRIME-FIX-12M-26-06-23', name: 'Prime Outgoing (9p/16p)', latest: true,
    warn: 'Pairing Prime Outgoing with Agile is not stated in the Smart Tariffs T&Cs — ' +
          'check eligibility with Octopus.',
  },
  seg: { code: null, flat: 4.1, name: 'SEG (flat)' },
  flat: { code: null, flat: 12.0, name: 'Custom flat rate' },
};

// ---------------------------------------------------------------- IndexedDB cache

let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const rq = indexedDB.open('octopus-rates', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('rates');
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  return dbp;
}

export async function cacheGet(key) {
  try {
    const d = await db();
    return await new Promise((res, rej) => {
      const rq = d.transaction('rates').objectStore('rates').get(key);
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => rej(rq.error);
    });
  } catch { return null; }
}

export async function cachePut(key, val) {
  try {
    const d = await db();
    await new Promise((res, rej) => {
      const rq = d.transaction('rates', 'readwrite').objectStore('rates').put(val, key);
      rq.onsuccess = () => res();
      rq.onerror = () => rej(rq.error);
    });
  } catch { /* cache is an optimisation; carry on without it */ }
}

export async function clearCache() {
  const d = await db();
  await new Promise((res) => {
    const rq = d.transaction('rates', 'readwrite').objectStore('rates').clear();
    rq.onsuccess = () => res();
  });
}

// ---------------------------------------------------------------- fetching

function iso(ms) { return new Date(ms).toISOString().slice(0, 16) + 'Z'; }

async function fetchPeriods(product, region, endpoint, startMs, endMs, onProgress) {
  const key = `${product}|${region}|${endpoint}|${iso(startMs)}|${iso(endMs)}`;
  const hit = await cacheGet(key);
  if (hit) return hit;

  let url = `${BASE}/${product}/electricity-tariffs/E-1R-${product}-${region}/${endpoint}/` +
            `?period_from=${iso(startMs)}&period_to=${iso(endMs)}&page_size=1500`;
  const rows = [];
  let page = 0;
  while (url) {
    const r = await fetch(url);
    if (!r.ok) {
      if (r.status === 404) {
        throw new Error(`No ${endpoint} for E-1R-${product}-${region} — that product may ` +
                        `not exist in region ${region}.`);
      }
      throw new Error(`Octopus API ${r.status} for ${product} ${endpoint}`);
    }
    const doc = await r.json();
    for (const x of doc.results) {
      if (x.value_inc_vat === null || x.value_inc_vat === undefined) continue;
      rows.push([
        Date.parse(x.valid_from),
        x.valid_to ? Date.parse(x.valid_to) : FAR_FUTURE,
        x.value_inc_vat,
      ]);
    }
    url = doc.next;
    page++;
    if (onProgress) onProgress(`${product} ${endpoint}: ${rows.length} rates (page ${page})`);
  }
  rows.sort((a, b) => a[0] - b[0]);
  await cachePut(key, rows);
  return rows;
}

// Map sorted [from,to,value] periods onto UTC instants. Two-pointer, O(n+m).
function series(periods, instants) {
  const out = new Array(instants.length);
  let i = 0;
  for (let k = 0; k < instants.length; k++) {
    const t = instants[k];
    while (i < periods.length && periods[i][1] <= t) i++;
    if (i < periods.length && periods[i][0] <= t && t < periods[i][1]) {
      out[k] = periods[i][2];
    } else {
      const hit = periods.find(([a, b]) => a <= t && t < b);
      out[k] = hit ? hit[2] : null;
    }
  }
  return out;
}

// ---------------------------------------------------------------- latest-rate projection

const DAY = 86400000;
const SLOT = 30 * 60000;
const londonHM = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

// Half-hour of the London wall clock (0..47). These tariffs' windows are local-time ones,
// so a winter 00:30Z period and a summer 23:30Z period are the same slot.
export function londonSlot(ms) {
  const [h, m] = londonHM.format(ms).split(':');
  return h * 2 + (m >= 30 ? 1 : 0);
}

// The newest published rate for each local half-hour, as a 48-entry day (null = none).
// Walks back two days from the last published instant and keeps the first hit per slot,
// so a 23-hour changeover day cannot leave its missing hour unpriced.
export function latestSchedule(periods, horizonMs) {
  const sched = new Array(48).fill(null);
  if (!periods.length) return sched;
  const end = Math.min(horizonMs, Math.max(...periods.map((r) => r[1])));
  let i = periods.length - 1;
  for (let t = Math.floor((end - 1) / SLOT) * SLOT, k = 0; k < 96; k++, t -= SLOT) {
    while (i >= 0 && periods[i][0] > t) i--;
    if (i < 0) break;
    const s = londonSlot(t);
    if (sched[s] === null && t < periods[i][1]) sched[s] = periods[i][2];
  }
  return sched;
}

// Rates for `instants`: the real history, or for a `latest` tariff today's schedule laid
// over every day. The window is anchored to the UTC day so the IndexedDB key rolls daily.
async function ratesFor(meta, region, endpoint, instants, startMs, endMs, onProgress) {
  if (!meta.latest) {
    return series(await fetchPeriods(meta.code, region, endpoint, startMs, endMs, onProgress), instants);
  }
  const today = Math.floor(Date.now() / DAY) * DAY;
  const horizon = today + 2 * DAY;
  const sched = latestSchedule(
    await fetchPeriods(meta.code, region, endpoint, today - 3 * DAY, horizon, onProgress), horizon);
  return instants.map((t) => sched[londonSlot(t)]);
}

export async function buildPrices(opts) {
  const { importKey, exportKey, region, instants, flatExport, onProgress } = opts;
  const startMs = instants[0];
  const endMs = instants[instants.length - 1] + 30 * 60000;
  const imeta = IMPORT_TARIFFS[importKey];
  const warnings = [];

  const impRaw = await ratesFor(imeta, region, 'standard-unit-rates', instants, startMs, endMs, onProgress);
  const missImp = impRaw.filter((v) => v === null).length;
  if (missImp) warnings.push(`${missImp.toLocaleString()} slots had no published import rate and were treated as 0p.`);
  const imp = impRaw.map((v) => (v === null ? 0 : v));

  const scSeries = await ratesFor(imeta, region, 'standing-charges', instants, startMs, endMs, onProgress);
  // accumulate per slot, so a part-day at either end is pro-rated and a mid-period
  // standing-charge change on Agile is honoured exactly
  const scTotalP = scSeries.reduce((a, v) => a + (v || 0) / 48, 0);
  const scDistinct = new Set(scSeries.filter((v) => v !== null)).size;

  const emeta = EXPORT_TARIFFS[exportKey];
  let exp;
  if (emeta.code) {
    const raw = await ratesFor(emeta, region, 'standard-unit-rates', instants, startMs, endMs, onProgress);
    const fb = flatExport ?? emeta.flat ?? 0;
    const gaps = raw.filter((v) => v === null).length;
    if (gaps) {
      warnings.push(`${gaps.toLocaleString()} of ${instants.length.toLocaleString()} slots had no ` +
                    `published ${emeta.name} rate; used ${fb.toFixed(2)}p for those.`);
    }
    exp = raw.map((v) => (v === null ? fb : v));
  } else if (exportKey === 'none') {
    exp = instants.map(() => 0);
  } else {
    const rate = flatExport ?? emeta.flat ?? 0;
    exp = instants.map(() => rate);
  }
  if (emeta.warn) warnings.push(emeta.warn);

  return {
    imp, exp, scTotalP, warnings,
    meta: {
      importName: imeta.name, importNote: imeta.note, exportName: emeta.name,
      importLatest: !!imeta.latest, exportLatest: !!emeta.latest,
      scPerDay: scTotalP / (instants.length / 48),
      scDistinct,
      impMin: Math.min(...imp), impMax: Math.max(...imp),
      impMean: imp.reduce((a, b) => a + b, 0) / imp.length,
      expMean: exp.reduce((a, b) => a + b, 0) / exp.length,
      expMax: Math.max(...exp),
      negSlots: imp.filter((v) => v < 0).length,
    },
  };
}
