// Asserts the JS 'discharge by next charge cycle' port converges to the IDENTICAL group
// structure and profit as the Python reference (test/adaptive_boundary.py), using the
// exact same input arrays. Regenerate the fixture with test/gen_cycle_fixture.py.
import { readFileSync } from 'node:fs';
import { makeCfg, solveDay } from '../js/optimiser.js';
import { cycleEdges } from '../js/data.js';

const fx = JSON.parse(readFileSync(new URL('./cycle_fixture.json', import.meta.url)));
const { imp, exp, load, days } = fx;
const T = load.length;

const initial = [0];
for (let i = 1; i < T; i++) if (days[i] !== days[i - 1]) initial.push(i);
initial.push(T);

let failed = 0;
for (const c of fx.configs) {
  const cfg = makeCfg(c.params);
  const edges = cycleEdges(imp, exp, load, cfg, c.mode, c.allowExport, initial);
  const sameEdges = edges.length === c.edges.length && edges.every((e, i) => e === c.edges[i]);

  let profit = 0;
  for (let g = 0; g < edges.length - 1; g++) {
    const [a, b] = [edges[g], edges[g + 1]];
    if (b - a < 2) continue;
    profit += solveDay(imp.slice(a, b), exp.slice(a, b), load.slice(a, b),
                       cfg, c.mode, c.allowExport).profit;
  }
  const pDiff = Math.abs(profit - c.profit);
  const ok = sameEdges && pDiff < 1e-4;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(26)} ` +
              `groups js ${edges.length - 1} py ${c.edges.length - 1} ` +
              `${sameEdges ? '(identical edges)' : '(EDGES DIFFER)'}  ` +
              `profit py £${(c.profit / 100).toFixed(2)} js £${(profit / 100).toFixed(2)} ` +
              `diff ${pDiff.toExponential(1)}p`);
  if (!sameEdges) {
    for (let i = 0; i < Math.max(edges.length, c.edges.length); i++) {
      if (edges[i] !== c.edges[i]) {
        console.log(`  first divergence at edge ${i}: js ${edges[i]} py ${c.edges[i]}`);
        break;
      }
    }
  }
}
console.log(failed ? `\n${failed} config(s) FAILED` : '\ncycle mode matches Python exactly');
process.exit(failed ? 1 : 0);
