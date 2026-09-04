// Fetch PV series for a postcode + arrays against a usage CSV, for test/score.mjs --pv.
// Node has fetch; the IndexedDB cache is a no-op here, so every run hits Open-Meteo (3 calls/array).
import { readFileSync, writeFileSync } from 'node:fs';
import { parseUsage } from '../js/data.js';
import { lookupPostcode, buildPv } from '../js/solar.js';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!args.usage || !args.postcode || !args.arrays || !args.out) {
  console.error("usage: node test/pv_fetch.mjs --usage u.csv --postcode 'RG31 6JU' --arrays '[{\"name\":\"rear\",\"bearing\":191,\"tilt\":90,\"kwp\":4,\"lossPct\":14,\"inverterKw\":3.68,\"coupling\":\"ac\"}]' --out pv.json");
  process.exit(2);
}
const usage = parseUsage(readFileSync(args.usage, 'utf8'));
const site = await lookupPostcode(args.postcode);
const { series, perArray } = await buildPv(usage, site, JSON.parse(args.arrays), fetch, (m) => console.error(m));
const plain = Object.fromEntries(Object.entries(series).map(([k, v]) => [k, Array.from(v)]));
writeFileSync(args.out, JSON.stringify({ site, perArray: perArray.map(({ arr, kwh, missing, filled }) => ({ name: arr.name, kwh, missing, filled })), series: plain }));
for (const p of perArray) console.error(`${p.arr.name || 'array'}: ${p.kwh.toFixed(0)} kWh/yr, ${p.missing} slots without data, ${p.filled} DST-filled`);
