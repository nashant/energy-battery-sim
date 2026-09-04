// (a) exact JS ≡ Python parity on the committed fixtures;
// (b) causality guard: garbage in the unpublished future must not change the past.
import { readFileSync } from 'node:fs';
import { runReplay } from '../js/data.js';
import { makeCfg } from '../js/optimiser.js';

const cases = JSON.parse(readFileSync(new URL('causal_fixture.json', import.meta.url)));
let fail = 0;
const ok = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) fail++; };

// 16:00 publishes the NEXT tariff day (23:00->23:00), so the cut must land on a
// tariff-day boundary — a mid-day cut (e.g. 15:00) was already published at 16:00 the
// day before and the standing plan read it legitimately. Slots before REVEAL are the
// ones decided from strictly pre-cut information.
const CUT = 20 * 48 + 46;      // 2025-01-26T23:00 — first slot of an unpublished tariff day
const REVEAL = 20 * 48 + 33;   // first slot governed by the 16:00 plan that reveals it

for (const c of cases) {
  const cfg = makeCfg(c.params);
  const { slots, replans } = runReplay(c.usage, c.load, c.imp, c.exp, cfg, c.params, c.pv ?? null);
  let worst = 0;
  slots.forEach((s, i) => {
    const e = c.expected.slots[i];
    worst = Math.max(worst, Math.abs(s.cin - e.cin), Math.abs(s.dl - e.dl),
                     Math.abs(s.dx - e.dx), Math.abs(s.soc - e.soc),
                     Math.abs((s.pvc || 0) - (e.pvc || 0)), Math.abs((s.pvx || 0) - (e.pvx || 0)));
  });
  ok(`parity ${c.meta.name} (worst ${worst.toExponential(1)})`, worst <= 1e-9);
  ok(`parity ${c.meta.name} replans`, replans === c.expected.replans);
  // The committed reference itself must obey the one-meter rule: parity alone can't
  // catch a shared bug, so assert it on the Python-generated expectations directly.
  const bothWays = c.expected.slots.filter((e) => e.cin > 1e-9 && e.dx > 1e-9).length;
  ok(`one-meter ${c.meta.name}: reference never charges and exports in one slot`,
     bothWays === 0);

  // causality: everything at/after the cut is garbage — prices inverted to absurd
  // values and load quadrupled. Nothing decided before the reveal may notice.
  // priceHorizon 'knownSchedule48h' reads the import schedule ahead by design (a fixed
  // time-of-use tariff), so only export and load are garbled for that case.
  const knownImp = c.params.priceHorizon === 'knownSchedule48h';
  const imp2 = c.imp.map((v, i) => (i >= CUT && !knownImp ? 999 : v));
  const exp2 = c.exp.map((v, i) => (i >= CUT ? -999 : v));
  const load2 = c.load.map((v, i) => (i >= CUT ? 17 : v));
  // PV: actual is garbage from the cut; a forecast value is garbage from the slot whose
  // forecast would have been ISSUED at/after the cut (day-1: cut + 48, day-2: cut + 96).
  // This guard cannot tell the +48 boundary from the +96 one: every plan issued before
  // REVEAL has a horizon ending at CUT, and no horizon of <= 48 slots ever needs F2 — so
  // a rule as loose as `t - 96 <= now` would pass here. The lead-time rule itself is
  // pinned by the PvForecaster unit tests in test/units.mjs ("pv base boundary").
  const garble = (arr, from) => arr && arr.map((v, i) => (i >= from ? 7 : v));
  const pv2 = c.pv && {
    ac: garble(c.pv.ac, CUT), dc: garble(c.pv.dc, CUT),
    acF1: garble(c.pv.acF1, CUT + 48), dcF1: garble(c.pv.dcF1, CUT + 48),
    acF2: garble(c.pv.acF2, CUT + 96), dcF2: garble(c.pv.dcF2, CUT + 96),
  };
  const a = runReplay(c.usage, c.load, c.imp, c.exp, cfg, c.params, c.pv ?? null).slots;
  const b = runReplay(c.usage, load2, imp2, exp2, cfg, c.params, pv2 ?? null).slots;
  const differs = (i) => a[i].cin !== b[i].cin || a[i].dl !== b[i].dl || a[i].dx !== b[i].dx ||
    a[i].pvc !== b[i].pvc || a[i].pvx !== b[i].pvx;
  let leak = -1;
  for (let i = 0; i < REVEAL; i++) if (differs(i)) { leak = i; break; }
  ok(`causality ${c.meta.name}: no future leakage before the cut` +
     (leak < 0 ? '' : ` (first leak ${leak} ${c.usage.wall[leak]})`), leak < 0);

  // the guard must not be vacuous: the garbage has to change something after it
  let moved = false;
  for (let i = REVEAL; i < a.length; i++) if (differs(i)) { moved = true; break; }
  ok(`causality ${c.meta.name}: garbage future does change post-reveal decisions`, moved);
}
process.exit(fail ? 1 : 0);
