// Unit tests for the pure helpers in js/data.js — no network, no DOM.
import { paybackYears, sweepCapacities, sweepInverters, parseGas, gasImpliedRates } from '../js/data.js';

let fail = 0;
const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) fail++; };
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// e = 0 degenerates to plain division
ok('payback e=0 is cost/save', close(paybackYears(3500, 1012, 0), 3500 / 1012));
ok('payback escPct omitted is cost/save', close(paybackYears(3500, 1012), 3500 / 1012));

// closed form: n = ln(1 + C·e/S) / ln(1+e); C=3500 S=1000 e=5% -> 3.30525…
const n = paybackYears(3500, 1000, 5);
ok('payback 5%/yr closed form', close(n, Math.log(1 + 3500 * 0.05 / 1000) / Math.log(1.05)));
// cross-check: cumulative saving S·((1+e)^n − 1)/e equals the cost at the crossing
ok('payback 5%/yr cumulative crossing', close(1000 * (Math.pow(1.05, n) - 1) / 0.05, 3500, 1e-6));

// negative escalation (falling prices) uses the same closed form, not plain division
const nNeg = paybackYears(3500, 1000, -3);
ok('payback -3%/yr differs from unescalated', !close(nNeg, 3.5, 1e-6));
ok('payback -3%/yr cumulative crossing',
   close(1000 * (Math.pow(0.97, nNeg) - 1) / -0.03, 3500, 1e-6));
// deflation steep enough that the saving never accumulates to the cost -> null
ok('payback null when deflation never repays', paybackYears(3500, 1000, -50) === null);

// guards
ok('payback null on zero cost', paybackYears(0, 1000, 5) === null);
ok('payback null on negative saving', paybackYears(3500, -5, 5) === null);
ok('payback null on zero saving', paybackYears(3500, 0, 5) === null);

import { gasBillPounds } from '../js/data.js';

// 5000 kWh matched gas (5200 metered − 200 unmatched) at 6.29p + 31.66p/day over 364 days
const bill = gasBillPounds({ gasKwh: 5200, unmatchedKwh: 200 }, 6.29, 31.66, 364);
ok('gas bill matched kWh + SC', close(bill, (5000 * 6.29 + 31.66 * 364) / 100, 1e-9));
ok('gas bill blank SC is rate only', close(gasBillPounds({ gasKwh: 5200, unmatchedKwh: 200 }, 6.29, null, 364), 5000 * 6.29 / 100));
ok('gas bill zero without unit rate', gasBillPounds({ gasKwh: 5200, unmatchedKwh: 200 }, null, 31.66, 364) === 0);
ok('gas bill zero for synthetic info', gasBillPounds({ hpKwh: 3000 }, 6.29, 31.66, 364) === 0);
ok('gas bill zero for null info', gasBillPounds(null, 6.29, 31.66, 364) === 0);

// implied gas rates derived from the CSV's own cost columns (Octopus gas export format)
const gasCsv = `Consumption (kwh), Estimated Cost Inc. Tax (p), Standing Charge Inc. Tax (p), Start, End
2.0000, 12, 15, 2026-07-28T00:00:00+01:00, 2026-07-28T00:30:00+01:00
1.0000, 6, 15, 2026-07-28T00:30:00+01:00, 2026-07-28T01:00:00+01:00
3.0000, 18, 30, 2026-07-29T00:00:00+01:00, 2026-07-29T00:30:00+01:00`;
const gasParsed = parseGas(gasCsv);
ok('parseGas keeps cost columns', close(gasParsed.actualP.reduce((a, b) => a + b, 0), 36)
   && close(gasParsed.scP.reduce((a, b) => a + b, 0), 60));
const ir = gasImpliedRates(gasParsed);
ok('implied gas unit rate = cost/kWh', close(ir.unitRateP, 36 / 6));
ok('implied gas SC/day over distinct days', close(ir.scPerDayP, 60 / 2));
const irZero = gasImpliedRates({ kwh: [1], utc: [0], actualP: [0], scP: [0] });
ok('implied rates null without cost data', irZero.unitRateP === null && irZero.scPerDayP === null);
const irLegacy = gasImpliedRates({ kwh: [1], utc: [0] });
ok('implied rates null for legacy gas shape', irLegacy.unitRateP === null && irLegacy.scPerDayP === null);

const caps = sweepCapacities(32);
ok('capacity grid for 32', JSON.stringify(caps) === JSON.stringify([16, 20, 24, 28, 32, 36, 40]));
ok('capacity grid contains the input', sweepCapacities(13.5).includes(13.5));
ok('capacity grid contains non-aligned input', sweepCapacities(13.55).includes(13.55));
ok('capacity grid is sorted with non-aligned input', sweepCapacities(13.55).every((v, i, a) => i === 0 || a[i-1] <= v));
ok('capacity grid rounds to 0.1', sweepCapacities(13.5).every((v) => close(v * 10, Math.round(v * 10))));
ok('capacity grid drops near-duplicate for non-aligned cap', sweepCapacities(13.44).length === 7);
ok('capacity grid keeps the raw non-aligned cap', sweepCapacities(13.44).includes(13.44));
ok('capacity grid drops the near-duplicate rounded value', !sweepCapacities(13.44).includes(13.4));
const invs = sweepInverters(10);
ok('inverter grid standard', JSON.stringify(invs) === JSON.stringify([3.6, 5, 6, 8, 10, 12]));
ok('inverter grid inserts odd size', JSON.stringify(sweepInverters(7)) === JSON.stringify([3.6, 5, 6, 7, 8, 10, 12]));


import { predictedExportKw } from '../js/data.js';

// voltage-rise ceiling: I = (Vmax − Vsrc)/Z, P = Vmax·I; 253 V = 230 V +10% statutory
ok('predict 242V 0.25Ω is 11.13 kW', close(predictedExportKw(242, 0.25), 253 * (253 - 242) / 0.25 / 1000));
ok('predict 242V 0.35Ω is 7.95 kW', close(predictedExportKw(242, 0.35), 253 * (253 - 242) / 0.35 / 1000));
ok('predict at statutory cap is 0', predictedExportKw(253, 0.25) === 0);
ok('predict above statutory cap is 0', predictedExportKw(258, 0.25) === 0);
ok('predict null on zero impedance', predictedExportKw(242, 0) === null);
ok('predict null on negative impedance', predictedExportKw(242, -0.1) === null);
ok('predict null on null voltage', predictedExportKw(null, 0.25) === null);
ok('predict null on zero voltage', predictedExportKw(0, 0.25) === null);

process.exit(fail ? 1 : 0);
