// Asserts the JS hold pass (js/data.js holdPass) reproduces the Python reference
// (test/pymodel.py hold_pass) exactly: identical group edges, identical held-energy
// sequence, identical booked totals. Regenerate with test/gen_hold_fixture.py.
import { readFileSync } from 'node:fs';
import { makeCfg, solveDay } from '../js/optimiser.js';
import { cycleEdges, holdPass } from '../js/data.js';

const cf = JSON.parse(readFileSync(new URL('./cycle_fixture.json', import.meta.url)));
const hf = JSON.parse(readFileSync(new URL('./hold_fixture.json', import.meta.url)));
const { imp, exp, load, days } = cf;
const T = load.length;
const midEdges = [0];
for (let i = 1; i < T; i++) if (days[i] !== days[i - 1]) midEdges.push(i);
midEdges.push(T);

let failed = 0;
for (const c of hf.configs) {
  const cfg = makeCfg(c.params);
  const edges = c.boundary === 'cycle'
    ? cycleEdges(imp, exp, load, cfg, c.mode || 'scattered', c.allowExport, midEdges)
    : midEdges;
  const sameEdges = edges.length === c.edges.length && edges.every((e, i) => e === c.edges[i]);

  const sols = [];
  for (let g = 0; g < edges.length - 1; g++) {
    const [a, b] = [edges[g], edges[g + 1]];
    sols.push({ a, b, r: solveDay(imp.slice(a, b), exp.slice(a, b), load.slice(a, b),
                                  cfg, c.mode || 'scattered', c.allowExport) });
  }
  const held = holdPass(sols, imp, exp, load, cfg);

  const pyHeld = new Map(c.held);
  let heldOk = true;
  for (let g = 0; g < held.length; g++) {
    if (Math.abs(held[g] - (pyHeld.get(g) || 0)) > 1e-6) { heldOk = false; break; }
  }

  let soc = 0, energyP = 0, outKwh = 0, viol = 0;
  for (const s of sols) {
    for (let n = 0; n < s.b - s.a; n++) {
      const t = s.a + n;
      const cin = s.r.charge.get(n) || 0;
      const dd = s.r.discharge.get(n) || { load: 0, export: 0 };
      soc += cin * cfg.eff - dd.load - dd.export;
      if (soc < -1e-6 || soc > cfg.cap + 1e-6) viol++;
      energyP += (load[t] + cin - dd.load) * imp[t] - dd.export * exp[t];
      outKwh += dd.load + dd.export;
    }
  }
  const eDiff = Math.abs(energyP - c.energy_p);
  const ok = sameEdges && heldOk && eDiff < 1e-4 && viol === c.violations
    && Math.abs(outKwh - c.out_kwh) < 1e-6;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(26)} ` +
    `energy py £${(c.energy_p / 100).toFixed(2)} js £${(energyP / 100).toFixed(2)} ` +
    `(diff ${eDiff.toExponential(1)}p)  held ${heldOk ? 'identical' : 'DIFFER'} ` +
    `(${held.reduce((a, b) => a + b, 0).toFixed(1)} kWh)  ` +
    `edges ${sameEdges ? 'identical' : 'DIFFER'}  violations ${viol}`);
}
console.log(failed ? `\n${failed} config(s) FAILED` : '\nhold pass matches Python exactly');
process.exit(failed ? 1 : 0);
