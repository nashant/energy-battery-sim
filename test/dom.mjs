// Cross-checks every element id the JS touches against the ids index.html defines, and
// exercises FlowDiagram against a real simulated slot using a minimal DOM stub.
// Catches typo'd ids and SVG-building errors without needing a browser.
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

const defined = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
// ids reach the DOM three ways: $('x'), getElementById('x'), and as bare string arguments
// to helpers (wireDrop('dropUsage', ...), num('exportLimitKw')) -- so count any quoted
// literal, else the unreferenced report is full of false positives
const quoted = new Set([...appJs.matchAll(/'([A-Za-z][A-Za-z0-9_]*)'/g)].map((m) => m[1]));
const direct = new Set([
  ...[...appJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
  ...[...appJs.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]),
]);
const used = new Set([...direct, ...[...quoted].filter((q) => defined.has(q))]);
// ids created at runtime by drawDayChart rather than declared in the HTML
const RUNTIME_IDS = new Set(['cursor', 'hoverG', 'hoverLine', 'hoverBg', 'hoverTime', 'hoverImp', 'hoverExp',
                             'hoverLoad', 'hoverSoc']);

let fail = 0;
const missing = [...direct].filter((id) => !defined.has(id) && !RUNTIME_IDS.has(id));
if (missing.length) { fail++; console.log(`FAIL  ids used in JS but absent from HTML: ${missing.join(', ')}`); }
else console.log(`PASS  all ${used.size} ids referenced by app.js exist in index.html`);

// ids in the HTML that nothing references -- not an error, but worth surfacing
const unused = [...defined].filter((id) => !used.has(id));
console.log(`      ${defined.size} ids in HTML; unreferenced: ${unused.length ? unused.join(', ') : 'none'}`);

// ---- FlowDiagram against a real slot, on a minimal DOM stub ----
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.style = {}; this._text = ''; }
  setAttribute(k, v) {
    if (v === undefined || v === null || (typeof v === 'number' && Number.isNaN(v))) {
      throw new Error(`${this.tag}: attribute ${k} set to ${v}`);
    }
    this.attrs[k] = String(v);
  }
  getAttribute(k) { return this.attrs[k]; }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { this.children.push(...cs); }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  set innerHTML(v) { this._html = v; this.children = []; }
  get innerHTML() { return this._html || ''; }
  querySelector() { return null; }
}
globalThis.document = {
  createElementNS: (_ns, tag) => new El(tag),
  createElement: (tag) => new El(tag),
  getElementById: () => null,
};

const { FlowDiagram } = await import('../js/flow.js');
const { parseUsage, runSim } = await import('../js/data.js');
const { buildPrices } = await import('../js/tariffs.js');

const usage = parseUsage(readFileSync('/home/anthonynash/Downloads/octopus-usage.csv', 'utf8'));
const pr = await buildPrices({ importKey: 'agile', exportKey: 'agile-outgoing', region: 'J',
                              instants: usage.utc, flatExport: null });
const r = runSim({
  usage, load: usage.kwh.slice(), imp: pr.imp, exp: pr.exp, scTotalP: pr.scTotalP,
  params: { capacity: 32, roundTrip: 0.9, inverterKw: 10, cycle: 'scattered',
            boundary: 'midnight', allowExport: true, useBattery: true,
            exportLimitKw: null, totalImportLimitKw: null, maxChargePrice: null },
});

const host = new El('div');
const fd = new FlowDiagram(host);
let charged = 0, discharged = 0, exported = 0, idle = 0;
for (const s of r.slots) {
  fd.update(s, 32);                      // throws on NaN/undefined attributes
  if (s.chg > 1e-9) charged++;
  if (s.disLoad > 1e-9) discharged++;
  if (s.disExp > 1e-9) exported++;
  if (s.chg < 1e-9 && s.disLoad < 1e-9 && s.disExp < 1e-9) idle++;
}
console.log(`PASS  FlowDiagram.update ran over all ${r.slots.length.toLocaleString()} slots without ` +
            `producing an invalid attribute`);
console.log(`      slot mix exercised: ${charged.toLocaleString()} charging, ` +
            `${discharged.toLocaleString()} discharging to load, ${exported.toLocaleString()} exporting, ` +
            `${idle.toLocaleString()} idle`);
if (!charged || !discharged || !exported || !idle) {
  fail++; console.log('FAIL  did not exercise every flow state');
}

console.log(fail ? `\n${fail} check(s) FAILED` : '\nDOM wiring checks passed');
process.exit(fail ? 1 : 0);
