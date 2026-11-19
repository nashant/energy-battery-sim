// Axle Energy VPP grid events (README "Axle"). Snapshot of a community-kept sheet, not
// verified by Axle: https://docs.google.com/spreadsheets/d/1ntwzF7lZGdc-JbXMasbBRNxCx49pV-5sUtl4i3mhbS8
// Rows before 2026-05-05 predate Axle's event maps: they list only the regions a participant
// reported, so any other region may have been called too.

export const AXLE_SNAPSHOT_TO = '2026-11-18';   // last event in the snapshot
export const AXLE_UPLIFT_P = 100;               // p per kWh exported during an event
export const AXLE_FLOOR_P = 1000;               // p per calendar month, minimum earnings
const SHORT_NOTICE_SLOTS = 4;                   // short-notice events give "at least 2 hours"

const ALL = 'ABCDEFGHJKLMNP';
// [local date, local start, minutes, type, regions confirmed included]
// type: N normal (announced the day before), S short notice (opt-in), T test (never paid for
// here). Regions are the GSP letters js/tariffs.js REGIONS uses.
export const AXLE_EVENTS = [
  ['2025-12-16', '08:00', 60, 'N', 'AD'],
  ['2026-01-06', '08:00', 60, 'N', 'AD'],
  ['2026-01-08', '10:00', 60, 'N', 'AD'],
  ['2026-01-26', '09:00', 60, 'N', 'AD'],
  ['2026-02-04', '08:00', 60, 'N', 'AD'],
  ['2026-02-17', '18:00', 60, 'N', 'ADGK'],
  ['2026-02-24', '18:00', 60, 'N', 'K'],
  ['2026-02-27', '17:00', 60, 'N', 'ADGK'],
  ['2026-03-03', '16:30', 60, 'N', 'ADGK'],
  ['2026-03-17', '17:00', 60, 'N', 'DK'],
  ['2026-03-26', '07:30', 60, 'N', 'ADFGKM'],
  ['2026-04-01', '08:00', 60, 'N', 'ADK'],
  ['2026-04-10', '08:30', 60, 'N', 'ABDFGKM'],
  ['2026-04-20', '08:00', 60, 'N', 'BM'],
  ['2026-05-05', '07:30', 60, 'N', 'ACDHJNP'],
  ['2026-05-08', '08:00', 60, 'N', 'BK'],
  ['2026-05-14', '08:00', 60, 'N', 'DFMN'],
  ['2026-05-21', '20:30', 60, 'N', ALL],
  ['2026-06-03', '08:00', 60, 'N', 'BEKL'],
  ['2026-06-10', '08:00', 60, 'N', ALL],
  ['2026-06-15', '07:00', 60, 'N', 'FM'],
  ['2026-06-16', '19:00', 60, 'N', 'BEHKLP'],
  ['2026-06-24', '19:00', 60, 'N', ALL],
  ['2026-06-30', '21:30', 60, 'N', 'ACDEFGJMNP'],
  ['2026-07-02', '22:00', 60, 'N', 'L'],
  ['2026-07-07', '22:30', 60, 'N', 'ADEFGHKMNP'],
  ['2026-07-10', '09:30', 30, 'N', 'L'],
  ['2026-07-16', '20:00', 60, 'N', 'BCDEFGLMNP'],
  ['2026-07-17', '06:00', 60, 'N', 'ABJKL'],
  ['2026-07-17', '15:00', 30, 'T', 'DEK'],
  ['2026-07-19', '06:00', 60, 'N', 'K'],
  ['2026-07-20', '20:00', 60, 'N', 'BCFGHJKMNP'],
  ['2026-07-21', '06:00', 60, 'N', 'DEFGHKMNP'],
  ['2026-07-22', '14:30', 30, 'T', 'DEK'],
  ['2026-07-22', '20:00', 60, 'N', 'BDEFGMNP'],
  ['2026-07-23', '20:00', 60, 'N', 'HJ'],
  ['2026-07-24', '13:30', 30, 'S', 'L'],
  ['2026-07-27', '20:00', 60, 'N', 'BL'],
  ['2026-07-29', '20:00', 60, 'N', 'CJ'],
  ['2026-07-30', '19:00', 60, 'N', 'FG'],
  ['2026-08-03', '20:00', 60, 'N', 'JL'],
  ['2026-08-04', '06:00', 60, 'N', 'BL'],
  ['2026-08-05', '06:00', 60, 'N', 'K'],
  ['2026-08-05', '21:00', 60, 'S', 'ABCDEFGHJKLM'],
  ['2026-08-06', '20:00', 60, 'N', 'HNP'],
  ['2026-08-07', '20:00', 60, 'N', 'B'],
  ['2026-08-09', '20:00', 60, 'N', 'BCH'],
  ['2026-08-10', '20:00', 60, 'N', 'CLMNP'],
  ['2026-08-11', '06:00', 60, 'N', 'ACJ'],
  ['2026-08-11', '19:30', 60, 'S', 'ABCDEFGHJKLM'],
  ['2026-08-12', '18:00', 120, 'N', ALL],
  ['2026-08-14', '20:00', 60, 'N', 'DEFGM'],
  ['2026-08-15', '20:00', 60, 'N', 'K'],
  ['2026-08-16', '20:00', 60, 'N', 'DFGK'],
  ['2026-08-17', '06:00', 60, 'N', 'AEJK'],
  ['2026-08-31', '20:00', 60, 'N', 'HJL'],
  ['2026-09-02', '06:30', 60, 'N', 'BJL'],
  ['2026-09-05', '19:30', 60, 'N', 'CDEFGHJKMNP'],
  ['2026-09-06', '06:00', 60, 'N', 'CHL'],
  ['2026-09-07', '19:00', 60, 'S', 'ABCDEFGHJKLM'],
  ['2026-09-08', '06:00', 60, 'N', 'K'],
  ['2026-09-09', '17:00', 60, 'N', 'L'],
  ['2026-09-10', '06:00', 60, 'N', 'K'],
  ['2026-09-11', '18:00', 60, 'N', ALL],
  ['2026-09-12', '20:00', 60, 'N', 'H'],
  ['2026-09-13', '19:00', 60, 'N', 'A'],
  ['2026-09-14', '06:30', 60, 'N', 'C'],
  ['2026-09-15', '19:00', 60, 'N', 'B'],
  ['2026-09-19', '06:00', 60, 'N', 'L'],
  ['2026-09-20', '19:30', 60, 'N', 'B'],
  ['2026-09-21', '18:30', 60, 'N', 'DEFGJKMNP'],
  ['2026-09-22', '18:00', 60, 'S', 'KN'],
  ['2026-09-24', '06:30', 60, 'N', 'AB'],
  ['2026-09-25', '20:00', 60, 'N', 'C'],
  ['2026-09-28', '18:00', 60, 'N', 'AFGNP'],
  ['2026-09-29', '06:00', 60, 'N', 'K'],
  ['2026-09-30', '19:00', 60, 'N', 'J'],
  ['2026-10-01', '18:00', 60, 'N', 'BCDEFGKLMNP'],
  ['2026-10-02', '07:00', 60, 'N', 'J'],
  ['2026-10-03', '18:30', 60, 'N', 'ACHJ'],
  ['2026-10-04', '18:30', 60, 'N', 'BL'],
  ['2026-10-05', '20:00', 60, 'N', 'BHKL'],
  ['2026-10-06', '19:30', 60, 'N', 'AEM'],
  ['2026-10-07', '06:00', 60, 'N', 'K'],
  ['2026-10-08', '19:30', 60, 'N', 'H'],
  ['2026-10-11', '19:00', 60, 'N', 'DFGNP'],
  ['2026-10-15', '20:00', 60, 'N', 'K'],
  ['2026-10-16', '07:00', 60, 'N', 'H'],
  ['2026-10-19', '20:00', 60, 'N', 'L'],
  ['2026-10-22', '17:30', 60, 'N', 'B'],
  ['2026-10-23', '06:00', 60, 'N', 'K'],
  ['2026-10-26', '07:30', 60, 'N', 'C'],
  ['2026-10-27', '19:00', 60, 'S', 'ABCDEFGHJKLM'],
  ['2026-10-28', '19:00', 60, 'N', 'HJ'],
  ['2026-10-29', '18:00', 60, 'N', 'AB'],
  ['2026-10-31', '20:00', 60, 'N', 'ACDEFGHJMNP'],
  ['2026-11-01', '06:00', 60, 'N', 'ADEFGHJKMNP'],
  ['2026-11-02', '17:00', 60, 'S', 'ABCDEFGHJKLM'],
  ['2026-11-04', '17:00', 60, 'S', 'CJ'],
  ['2026-11-06', '14:00', 30, 'T', ALL],
  ['2026-11-17', '19:00', 60, 'N', 'HKL'],
  ['2026-11-18', '20:00', 60, 'N', 'ABCDEFGJMNP'],
];

const SLOT = 30 * 60000;
const london = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const londonOffset = (ms) => {
  const p = Object.fromEntries(london.formatToParts(ms).map((x) => [x.type, x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - ms;
};

// Events are announced in UK local time; the model keys prices by UTC instant. The second
// offset lookup is taken at the corrected instant, so a time just after a clock change
// resolves against its own side of it.
export function londonToUtc(date, hhmm) {
  const floating = Date.parse(`${date}T${hhmm}:00Z`);
  return floating - londonOffset(floating - londonOffset(floating));
}

// The uplift laid over a usage series for one region. `covered(ym)` says whether a calendar
// month falls inside what the snapshot knows about that region — from the region's first
// recorded event to the snapshot's end. Outside it there are no events and no monthly
// floor: an unrecorded month is unknown, not a quiet one.
export function axleSeries(usage, region, { shortNotice = false } = {}) {
  const T = usage.utc.length;
  const upP = new Float64Array(T);
  // first slot index whose plan may see the uplift; 0 leaves it to the price horizon, which
  // already opens a day ahead like Axle's own day-before notice
  const visFrom = new Int32Array(T);
  const index = new Map();
  for (let i = 0; i < T; i++) index.set(usage.utc[i], i);

  let events = 0, from = null;
  for (const [date, start, mins, type, areas] of AXLE_EVENTS) {
    if (type === 'T' || !areas.includes(region)) continue;
    if (from === null) from = date.slice(0, 7);
    if (type === 'S' && !shortNotice) continue;
    const t0 = londonToUtc(date, start);
    let hit = false;
    for (let k = 0; k < mins / 30; k++) {
      const i = index.get(t0 + k * SLOT);
      if (i === undefined) continue;
      upP[i] = AXLE_UPLIFT_P;
      if (type === 'S') visFrom[i] = Math.max(0, i - k - SHORT_NOTICE_SLOTS);
      hit = true;
    }
    if (hit) events++;
  }
  const to = AXLE_SNAPSHOT_TO.slice(0, 7);
  return { upP, visFrom, events, from, to, floorP: AXLE_FLOOR_P,
           covered: (ym) => from !== null && ym >= from && ym <= to };
}
