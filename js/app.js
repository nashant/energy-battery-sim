import { REGIONS, IMPORT_TARIFFS, EXPORT_TARIFFS, buildPrices, clearCache,
         cacheGet, cachePut } from './tariffs.js';
import { parseUsage, parseGas, heatPumpFromGas, heatPumpSynthetic, runSim, currentTariffTotal, paybackYears, roiPct, gasBillPounds, gasImpliedRates, sweepCapacities, sweepInverters, predictedExportKw, slotAtX } from './data.js';
import { FlowDiagram } from './flow.js';
import { lookupPostcode, buildPv } from './solar.js';

const $ = (id) => document.getElementById(id);
const gbp = (n) => (n < 0 ? '−' : '') + '£' + Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// filenames are the one attacker-influenceable string that reaches innerHTML
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const status = (html) => { $('status').innerHTML = html; };
const showError = (m) => { $('errBox').innerHTML = `<div class="err">${m}</div>`; };
const clearError = () => { $('errBox').innerHTML = ''; };

const state = { usage: null, gas: null, run: null, flow: null, timer: null, dayIndex: new Map() };
state.solar = { postcode: '', lat: null, lon: null, arrays: [], pv: null, pvKey: null };

// ------------------------------------------------------------------ init

for (const [k, v] of Object.entries(REGIONS)) {
  $('region').append(new Option(`${k} — ${v}`, k, false, k === 'J'));
}
for (const [k, v] of Object.entries(IMPORT_TARIFFS)) {
  $('importTariff').append(new Option(v.name, k, false, k === 'agile'));
}
for (const [k, v] of Object.entries(EXPORT_TARIFFS)) {
  $('exportTariff').append(new Option(v.name, k));
}

function syncTariffUi() {
  const t = IMPORT_TARIFFS[$('importTariff').value];
  $('tariffNote').textContent = t.note;
  for (const o of $('exportTariff').options) o.disabled = !t.exports.includes(o.value);
  const ek = $('exportTariff').value;
  $('flatWrap').classList.toggle('hide', !(ek === 'flat' || ek === 'seg' || ek === 'prime'));
  if (ek === 'seg') $('flatExport').value = 4.1;
}
$('importTariff').onchange = () => {
  $('exportTariff').value = IMPORT_TARIFFS[$('importTariff').value].exports[0];
  syncTariffUi();
};
$('exportTariff').onchange = syncTariffUi;
$('importTariff').dispatchEvent(new Event('change'));

$('curSource').onchange = () => {
  $('curManualWrap').classList.toggle('hide', $('curSource').value !== 'manual');
};

// Predicted export cap: the checkbox takes over the G100 box (disabled, value
// computed from voltage-rise headroom); unticking restores whatever was typed.
function syncPredictExport() {
  const on = $('predictExport').checked;
  $('predictExportWrap').classList.toggle('hide', !on);
  const box = $('exportLimitKw');
  box.disabled = on;
  if (!on) {
    if (box.dataset.manual !== undefined) { box.value = box.dataset.manual; delete box.dataset.manual; }
    return;
  }
  if (box.dataset.manual === undefined) box.dataset.manual = box.value;
  const kw = predictedExportKw(Number($('sourceVolts').value), Number($('sourceOhms').value));
  box.value = kw === null ? '' : kw.toFixed(2);
}
$('predictExport').onchange = syncPredictExport;
$('sourceOhms').oninput = syncPredictExport;
$('sourceVolts').oninput = syncPredictExport;

// CSS cannot override <details open>, so force it open above the breakpoint
const WIDE = () => window.innerWidth > 1000;
function syncControls() {
  if (WIDE()) $('controls').open = true;
  const p = IMPORT_TARIFFS[$('importTariff').value];
  const e = EXPORT_TARIFFS[$('exportTariff').value];
  $('controlsSummary').querySelector('.sumdetail').textContent =
    `${p.name} · ${(e.code || e.flat) ? e.name : 'no export'} · region ${$('region').value} · ` +
    `${$('capacity').value} kWh / ${$('inverterKw').value} kW`;
}
window.addEventListener('resize', syncControls);
for (const id of ['region', 'importTariff', 'exportTariff', 'capacity', 'inverterKw']) {
  $(id).addEventListener('change', syncControls);
}
syncControls();

$('hpMode').onchange = () => {
  const m = $('hpMode').value;
  $('hpSynthWrap').classList.toggle('hide', m !== 'synthetic');
  $('hpGasWrap').classList.toggle('hide', m !== 'gas');
  $('hpCostWrap').classList.toggle('hide', m === 'none');
};

// ------------------------------------------------------------------ file input

function wireDrop(dropId, inputId, onText) {
  const drop = $(dropId), input = $(inputId);
  drop.onclick = () => input.click();
  input.onchange = () => input.files[0] && read(input.files[0]);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => {
    e.preventDefault(); drop.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) read(f);
  };
  function read(file) {
    const fr = new FileReader();
    fr.onload = () => {
      try { onText(fr.result, file.name); drop.classList.add('ok'); }
      catch (err) { showError(`${esc(file.name)}: ${esc(err.message)}`); drop.classList.remove('ok'); }
    };
    fr.readAsText(file);
  }
}

function loadUsage(text, name, fromCache = false) {
  const u = parseUsage(text);
  state.usage = u;
  const kwh = u.kwh.reduce((a, b) => a + b, 0);
  const days = u.utc.length / 48;
  $('usageInfo').innerHTML =
    `<b>${esc(name)}</b>${fromCache ? ' · restored from this browser’s cache' : ''}` +
    `<br>${u.utc.length.toLocaleString()} slots · ${days.toFixed(2)} days · ` +
    `${kwh.toLocaleString('en-GB', { maximumFractionDigits: 0 })} kWh ` +
    `(${(kwh / days).toFixed(1)} kWh/day)<br>${u.wall[0]} → ${u.wall[u.wall.length - 1]}`;
  $('run').disabled = false;
  $('compare').disabled = false;

  // does this export actually carry price data, or must the user type rates in?
  const probe = currentTariffTotal(u, null);
  if (probe.hasCsvCost) {
    $('curCsvNote').textContent =
      `Cost column found: ${gbp(probe.energy)} energy + ${gbp(probe.sc)} standing charges, ` +
      `implying ${probe.impliedRate.toFixed(2)} p/kWh.`;
    $('curUnitRate').value = probe.impliedRate.toFixed(2);
    if (probe.hasCsvSc) $('curScPerDay').value = (probe.sc * 100 / (u.utc.length / 48)).toFixed(2);
  } else {
    $('curCsvNote').innerHTML =
      '<b>No cost column in this export</b> — switch to manual rates, or the current-tariff ' +
      'comparison will read zero.';
    $('curSource').value = 'manual';
    $('curSource').dispatchEvent(new Event('change'));
  }
  clearError();
}

function loadGas(text, name, fromCache = false) {
  const g = parseGas(text);
  state.gas = g;
  const tot = g.kwh.reduce((a, b) => a + b, 0);
  const imp = gasImpliedRates(g);
  $('gasInfo').innerHTML = `<b>${esc(name)}</b>` +
    `${fromCache ? ' · restored from this browser’s cache' : ''}` +
    `<br>${g.utc.length.toLocaleString()} readings · ` +
    `${tot.toLocaleString('en-GB', { maximumFractionDigits: 0 })} kWh gas (from ${g.unit})` +
    (imp.unitRateP !== null
      ? ` · implied ${imp.unitRateP.toFixed(2)} p/kWh` +
        (imp.scPerDayP !== null ? ` + ${imp.scPerDayP.toFixed(2)} p/day` : '')
      : '');
  $('hpMode').value = 'gas';
  $('hpMode').dispatchEvent(new Event('change'));
  // surface the implied prices as editable values; never clobber a manual entry
  if (imp.unitRateP !== null && $('gasUnitRate').value.trim() === '') {
    $('gasUnitRate').value = imp.unitRateP.toFixed(2);
  }
  if (imp.scPerDayP !== null && $('gasScPerDay').value.trim() === '') {
    $('gasScPerDay').value = imp.scPerDayP.toFixed(2);
  }
}

wireDrop('dropUsage', 'fileUsage', (text, name) => {
  loadUsage(text, name);
  cachePut('csv:usage', { name, text });    // stays in this browser's IndexedDB only
});

wireDrop('dropGas', 'fileGas', (text, name) => {
  loadGas(text, name);
  cachePut('csv:gas', { name, text });
});

// ------------------------------------------------------------------ solar
const DIRS = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
const newArray = () => ({ id: Math.random().toString(36).slice(2, 8), name: `Array ${state.solar.arrays.length + 1}`,
  bearing: 180, tilt: 35, kwp: 4, inverterKw: 3.68, lossPct: 14, coupling: 'ac', cost: 5000, enabled: true });
// rows saved before the toggle existed have no `enabled`: they are in the run
const activeArrays = () => state.solar.arrays.filter((a) => a.enabled !== false);
const solarKey = () => JSON.stringify({ lat: state.solar.lat, lon: state.solar.lon,
  arrays: state.solar.arrays.map((a) => [a.enabled !== false, a.bearing, a.tilt, a.kwp, a.inverterKw, a.lossPct, a.coupling]) });

function renderArrays() {
  const s = state.solar;
  $('arrays').innerHTML = s.arrays.map((a) => `
    <div class="array${a.enabled !== false ? '' : ' off'}" data-id="${a.id}">
      <div class="hdr">
        <label class="inc"><input type="checkbox" data-k="enabled" ${a.enabled !== false ? 'checked' : ''}> include in run</label>
        <button type="button" class="rm" data-rm="${a.id}">remove</button>
      </div>
      <div class="row4">
        <div><label>Name</label><input data-k="name" type="text" value="${esc(a.name)}"></div>
        <div><label>Faces (°)</label><input data-k="bearing" type="number" min="0" max="359" value="${a.bearing}"></div>
        <div><label>Direction</label><select data-dir>${Object.keys(DIRS).map((d) =>
          `<option value="${d}" ${DIRS[d] === a.bearing ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
        <div><label>Tilt (°)</label><input data-k="tilt" type="number" min="0" max="90" value="${a.tilt}"></div>
      </div>
      <div class="row4">
        <div><label>kWp</label><input data-k="kwp" type="number" step="0.1" value="${a.kwp}"></div>
        <div><label>Inverter (kW)</label><input data-k="inverterKw" type="number" step="0.01" value="${a.inverterKw ?? ''}" placeholder="no clip"></div>
        <div><label>Losses (%)</label><input data-k="lossPct" type="number" step="1" value="${a.lossPct}"></div>
        <div><label>Cost (£)</label><input data-k="cost" type="number" step="50" value="${a.cost ?? ''}"></div>
      </div>
      <label>Coupling</label>
      <select data-k="coupling">
        <option value="ac" ${a.coupling === 'ac' ? 'selected' : ''}>AC — own inverter, independent of the battery</option>
        <option value="dc" ${a.coupling === 'dc' ? 'selected' : ''}>DC — into the battery's hybrid inverter</option>
      </select>
      <div class="note" data-status>${a.enabled === false ? 'excluded from the run'
        : s.pv && s.pvKey === solarKey() ? pvStatusFor(a) : 'not fetched'}</div>
    </div>`).join('');
  $('fetchPv').disabled = !(s.lat && activeArrays().length);
}
function pvStatusFor(a) {
  const p = state.solar.pv?.perArray.find((x) => x.arr.id === a.id);
  return p ? `${p.kwh.toFixed(0)} kWh/yr${p.missing ? ` · ${p.missing} slots without data` : ''}` : 'not fetched';
}
$('arrays').addEventListener('input', (e) => {
  const row = e.target.closest('.array'); if (!row) return;
  const a = state.solar.arrays.find((x) => x.id === row.dataset.id);
  const k = e.target.dataset.k;
  if (k === 'enabled') { a.enabled = e.target.checked; renderArrays(); return; }
  if (e.target.dataset.dir !== undefined) { a.bearing = DIRS[e.target.value]; row.querySelector('[data-k="bearing"]').value = a.bearing; }
  else if (k === 'name' || k === 'coupling') a[k] = e.target.value;
  else if (k) a[k] = e.target.value === '' ? null : Number(e.target.value);
  if (k === 'bearing') row.querySelector('[data-dir]').value = Object.keys(DIRS).find((d) => DIRS[d] === a.bearing) ?? '';
  $('fetchPv').disabled = !(state.solar.lat && activeArrays().length);
});
$('arrays').addEventListener('click', (e) => {
  const id = e.target.dataset.rm; if (!id) return;
  state.solar.arrays = state.solar.arrays.filter((a) => a.id !== id); renderArrays();
});
$('addArray').onclick = () => { state.solar.arrays.push(newArray()); renderArrays(); };
$('locate').onclick = async () => {
  try {
    const site = await lookupPostcode($('postcode').value);
    Object.assign(state.solar, { postcode: site.postcode, lat: site.lat, lon: site.lon });
    $('siteNote').textContent = `${site.postcode}: ${site.lat.toFixed(4)}, ${site.lon.toFixed(4)}`;
    renderArrays();
  } catch (e) { $('siteNote').textContent = e.message; }
};
async function ensurePv() {
  const s = state.solar, active = activeArrays();
  // no arrays, or every array switched out of the run: no PV at all
  if (!active.length) { s.pv = null; s.pvKey = null; return null; }
  // arrays with no located site would otherwise run as if there were no solar at all
  // while payback still charged for the panels. Run and Compare show the message.
  if (!s.lat) throw new Error('Solar arrays are configured but the postcode has not been located — press Locate first.');
  if (s.pv && s.pvKey === solarKey()) return s.pv.series;
  const { series, perArray } = await buildPv(state.usage, s, active, fetch,
    (m) => { $('pvNote').textContent = m; });
  s.pv = { series, perArray }; s.pvKey = solarKey();
  const excluded = s.arrays.length - active.length;
  $('pvNote').textContent = `${perArray.reduce((a, p) => a + p.kwh, 0).toFixed(0)} kWh/yr across ${perArray.length} array(s)` +
    (excluded ? `, ${excluded} excluded` : '');
  renderArrays();
  return series;
}
$('fetchPv').onclick = async () => { if (!state.usage) { showError('Load a usage CSV first — irradiance is fetched for its date range.'); return; } try { await ensurePv(); } catch (e) { showError(e.message); } };

// ------------------------------------------------------------------ remembered inputs
// Every control in the panel is saved when Run, Compare or a sweep starts and put back on
// the next visit, after the CSVs, so a value typed over a CSV-derived one wins.
const FORM_KEY = 'form:controls';
const controls = () =>
  [...$('controls').querySelectorAll('input[id], select[id]')].filter((el) => el.type !== 'file');
function saveControls() {
  const v = {};
  for (const el of controls()) v[el.id] = el.type === 'checkbox' ? el.checked : el.value;
  v.solar = { postcode: state.solar.postcode, lat: state.solar.lat, lon: state.solar.lon, arrays: state.solar.arrays };
  cachePut(FORM_KEY, v);
}
async function restoreControls() {
  const v = await cacheGet(FORM_KEY);
  if (!v) return;
  for (const el of controls()) {
    if (!(el.id in v)) continue;
    if (el.type === 'checkbox') el.checked = !!v[el.id]; else el.value = v[el.id];
  }
  if (v.solar) {
    Object.assign(state.solar, v.solar);
    $('postcode').value = v.solar.postcode || v.postcode || '';
    if (v.solar.lat) $('siteNote').textContent = `${v.solar.postcode}: ${v.solar.lat.toFixed(4)}, ${v.solar.lon.toFixed(4)}`;
    renderArrays();
  }
  // re-sync the dependent UI without the import handler, which would reset the export
  syncTariffUi(); syncPredictExport(); syncControls();
  $('curSource').dispatchEvent(new Event('change'));
  $('hpMode').dispatchEvent(new Event('change'));
}

// restore a previously dropped CSV so returning visitors skip the upload
(async () => {
  const u = await cacheGet('csv:usage');
  if (u && u.text && !state.usage) {
    try { loadUsage(u.text, u.name, true); $('dropUsage').classList.add('ok'); } catch { /* stale */ }
  }
  const g = await cacheGet('csv:gas');
  if (g && g.text && !state.gas) {
    try { loadGas(g.text, g.name, true); $('dropGas').classList.add('ok'); } catch { /* stale */ }
  }
  await restoreControls();
})();

// ------------------------------------------------------------------ params

function params() {
  const num = (id) => { const v = $(id).value.trim(); return v === '' ? null : Number(v); };
  return {
    region: $('region').value,
    importKey: $('importTariff').value,
    exportKey: $('exportTariff').value,
    flatExport: num('flatExport'),
    capacity: Number($('capacity').value),
    roundTrip: Number($('roundTrip').value) / 100,
    dischargeFloorPct: num('dischargeFloor') || 0,
    inverterKw: Number($('inverterKw').value),
    cycleLife: num('cycleLife'),
    exportLimitKw: num('exportLimitKw'),
    totalImportLimitKw: num('totalImportLimitKw'),
    maxChargePrice: num('maxChargePrice'),
    cycle: $('cycle').value,
    holdFor: $('holdFor').value,
    packEnergyWorth: $('packEnergyWorth').value,
    priceHorizon: $('priceHorizon').value,
    replanEvery: num('replanEvery') || 1,
    batteryCost: num('batteryCost'),
    inverterCost: num('inverterCost'),
    installCost: num('installCost'),
    escPct: num('escPct') || 0,
    allowExport: $('exportTariff').value !== 'none',
    curSource: $('curSource').value,
    curUnitRate: num('curUnitRate'),
    curScPerDay: num('curScPerDay'),
    hpMode: $('hpMode').value,
    hpKwh: Number($('hpKwh').value),
    boilerEff: Number($('boilerEff').value),
    cop: Number($('cop').value),
    hpCost: num('hpCost'),
    gasUnitRate: num('gasUnitRate'),
    gasScPerDay: num('gasScPerDay'),
    solarCost: activeArrays().reduce((a, x) => a + (x.cost || 0), 0),
  };
}

// null override => use the CSV's own cost columns
function curOverride(p) {
  return p.curSource === 'manual'
    ? { unitRateP: p.curUnitRate, scPerDayP: p.curScPerDay } : null;
}

function buildLoad(p) {
  const base = state.usage.kwh;
  let add = null, info = null;
  if (p.hpMode === 'synthetic') ({ add, info } = heatPumpSynthetic(state.usage, p.hpKwh));
  else if (p.hpMode === 'gas') {
    if (!state.gas) throw new Error('Heat pump source is "from gas CSV" but no gas CSV is loaded.');
    ({ add, info } = heatPumpFromGas(state.usage, state.gas, p.boilerEff, p.cop));
  }
  return { load: add ? base.map((v, i) => v + add[i]) : base.slice(), add, info };
}

// ------------------------------------------------------------------ run

$('run').onclick = async () => {
  const p = params();
  saveControls();
  clearError();
  $('run').disabled = true;
  try {
    status('<span class="spinner"></span> fetching rates…');
    const { load, add, info } = buildLoad(p);
    const pv = await ensurePv();
    const prices = await buildPrices({
      importKey: p.importKey, exportKey: p.exportKey, region: p.region,
      instants: state.usage.utc, flatExport: p.flatExport,
      onProgress: (m) => status(`<span class="spinner"></span> ${m}`),
    });
    status('<span class="spinner"></span> optimising 365 days…');
    await new Promise((r) => setTimeout(r, 0));

    const withBat = runSim({ usage: state.usage, load, imp: prices.imp, exp: prices.exp,
                             scTotalP: prices.scTotalP, pv, params: { ...p, useBattery: true } });
    const noBat = runSim({ usage: state.usage, load, imp: prices.imp, exp: prices.exp,
                           scTotalP: prices.scTotalP, pv, params: { ...p, useBattery: false } });
    const cur = currentTariffTotal(state.usage, add, curOverride(p));

    state.run = { p, prices, withBat, noBat, cur, hpInfo: info };
    render();
    status('done');
  } catch (e) {
    showError(e.message);
    status('');
  } finally {
    $('run').disabled = false;
  }
};

$('compare').onclick = async () => {
  const p = params();
  saveControls();
  clearError();
  $('compare').disabled = true;
  const rows = [];
  try {
    const { load, add } = buildLoad(p);
    const pv = await ensurePv();
    const cur = currentTariffTotal(state.usage, add, curOverride(p));
    const combos = [];
    // every permitted pairing that has a published product (custom flat rates are UI-only)
    for (const [ik, iv] of Object.entries(IMPORT_TARIFFS)) {
      for (const ek of iv.exports) if (ek === 'none' || EXPORT_TARIFFS[ek].code) combos.push({ ik, ek });
    }
    for (const c of combos) {
      status(`<span class="spinner"></span> ${IMPORT_TARIFFS[c.ik].name} / ${EXPORT_TARIFFS[c.ek].name}…`);
      const pr = await buildPrices({
        importKey: c.ik, exportKey: c.ek, region: p.region, instants: state.usage.utc,
        flatExport: p.flatExport,
        onProgress: (m) => status(`<span class="spinner"></span> ${m}`),
      });
      await new Promise((r) => setTimeout(r, 0));
      const wb = runSim({ usage: state.usage, load, imp: pr.imp, exp: pr.exp,
                          scTotalP: pr.scTotalP, pv,
                          params: { ...p, allowExport: c.ek !== 'none', useBattery: true } });
      const nb = runSim({ usage: state.usage, load, imp: pr.imp, exp: pr.exp,
                          scTotalP: pr.scTotalP, pv,
                          params: { ...p, allowExport: c.ek !== 'none', useBattery: false } });
      rows.push({ ...c, wb, nb, note: IMPORT_TARIFFS[c.ik].note });
    }
    renderCompare(rows, cur, systemCost(p), p.escPct);
    status('done');
  } catch (e) {
    showError(e.message);
    status('');
  } finally {
    $('compare').disabled = false;
  }
};

$('runSweeps').onclick = async () => {
  if (!state.run) return;
  const { p, prices, withBat, cur } = state.run;
  $('runSweeps').disabled = true;
  try {
    const { load } = buildLoad(p);
    const base = { usage: state.usage, load, imp: prices.imp, exp: prices.exp,
                   scTotalP: prices.scTotalP, pv: state.solar.pv?.series ?? null };
    const annual = 365 / withBat.nDays;
    const one = async (key, v, unit) => {
      status(`<span class="spinner"></span> sweep: ${v} ${unit}…`);
      await new Promise((r) => setTimeout(r, 0));
      const r0 = v === p[key] ? withBat
        : runSim({ ...base, params: { ...p, [key]: v, useBattery: true } });
      return { v, total: r0.total };
    };
    const caps = [];
    for (const v of sweepCapacities(p.capacity)) caps.push(await one('capacity', v, 'kWh pack'));
    const invs = [];
    for (const v of sweepInverters(p.inverterKw)) invs.push(await one('inverterKw', v, 'kW inverter'));
    $('sweepOut').innerHTML = sweepTables(caps, invs, p, cur, annual);
    status('done');
  } catch (e) {
    showError(e.message); status('');
  } finally {
    $('runSweeps').disabled = false;
  }
};

// Two tables. Marginal columns compare consecutive rows; the capacity table also prices
// the marginal kWh at batteryCost/capacity (blank when no battery cost is given).
function sweepTables(caps, invs, p, cur, annual) {
  const perKwh = p.batteryCost > 0 ? p.batteryCost / p.capacity : null;
  // Total/Saving columns use the same CSV-window measure as the main cards (so the
  // current row matches the "Saving vs current" card exactly); only the marginal
  // columns are annualised, because they make /yr claims.
  const row = (r, i, rows, marginalCols) => {
    const saving = cur.total - r.total;
    const cells = [`${r.v}`, gbp(r.total), gbp(saving)];
    if (i === 0) marginalCols.forEach(() => cells.push('—'));
    else {
      const dv = r.v - rows[i - 1].v;
      const ds = (rows[i - 1].total - r.total) * annual;   // annualised marginal saving
      for (const col of marginalCols) {
        if (col === 'value') cells.push(`${gbp(ds / dv)}/yr`);
        else cells.push(perKwh !== null ? fmtYears(paybackYears(perKwh * dv, ds, p.escPct)) : '—');
      }
    }
    const curCls = r.v === (marginalCols.length === 2 ? p.capacity : p.inverterKw) ? ' class="cur"' : '';
    return `<tr${curCls}>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  };
  const table = (id, head, rows, marginalCols) =>
    `<table id="${id}"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.map((r, i) => row(r, i, rows, marginalCols)).join('')}</tbody></table>`;
  return table('sweepCapTable',
      ['Pack kWh', 'Total £', 'Saving £', 'Marginal £/kWh·yr', 'Marginal payback'],
      caps, ['value', 'payback']) +
    table('sweepInvTable',
      ['Inverter kW', 'Total £', 'Saving £', 'Marginal £/kW·yr'],
      invs, ['value']);
}

$('clearCache').onclick = async () => {
  await clearCache();
  status('cached rates, data & remembered inputs cleared');
};

// ------------------------------------------------------------------ render

function render() {
  const { p, prices, withBat, noBat, cur, hpInfo } = state.run;
  $('intro').classList.add('hide');
  $('results').classList.remove('hide');
  $('sensSection').classList.remove('hide');
  $('sweepOut').innerHTML = '';            // stale sweeps must not outlive their inputs
  syncControls();
  if (!WIDE()) {
    $('controls').open = false;              // reveal the results on a phone
    $('cards').scrollIntoView({ block: 'start' });
  }
  $('resultTitle').textContent =
    `${prices.meta.importName} · ${prices.meta.exportName} · region ${p.region}`;

  const save = cur.total - withBat.total;
  const cost = systemCost(p);
  // `cost` includes the array, so the battery-only figures (which measure
  // savedVsNoBattery, the marginal saving over a PV-netted baseline) divide by the
  // battery's own share of the spend.
  const solarCost = p.solarCost || 0;
  const battCost = cost - solarCost;
  const annual = 365 / withBat.nDays;      // CSV period -> per-year
  // Full-ledger payback: do-nothing = current tariff on RAW usage (no heat pump) plus
  // the gas bill; new world = withBat.total (already includes any heat pump load).
  // With no HP cost and no gas credit this reduces exactly to save × annual.
  const hpCost = p.hpMode === 'none' ? 0 : (p.hpCost || 0);
  // manual gas prices override; otherwise fall back to rates implied by the gas
  // CSV's own cost columns (mirrors the electricity side's implied rate)
  const gasImp = p.hpMode === 'gas' && state.gas
    ? gasImpliedRates(state.gas) : { unitRateP: null, scPerDayP: null };
  const gasRate = p.gasUnitRate ?? gasImp.unitRateP;
  const gasBill = p.hpMode === 'gas'
    ? gasBillPounds(hpInfo, gasRate, p.gasScPerDay ?? gasImp.scPerDayP, withBat.nDays) : 0;
  const invest = cost + hpCost;
  const pbSave = (hpCost > 0 || gasBill > 0
    ? currentTariffTotal(state.usage, null, curOverride(p)).total + gasBill - withBat.total
    : save) * annual;
  const pbBatt = paybackYears(battCost, withBat.savedVsNoBattery * annual, p.escPct);
  const pbCur = paybackYears(invest, pbSave, p.escPct);
  // year-1 simple return; escalation grows it in later years, so this is the floor
  const roiCur = roiPct(invest, pbSave);
  const roiBatt = roiPct(battCost, withBat.savedVsNoBattery * annual);
  const fmtRoi = (r) => r === null ? '' : ` · ${r.toFixed(1)}%/yr`;
  // Investment breakdown; with neither solar nor a heat pump the single total reads better.
  const costParts = solarCost > 0 || hpCost > 0 ? [
    `${gbp(battCost)} battery`,
    ...(solarCost > 0 ? [`${gbp(solarCost)} solar`] : []),
    ...(hpCost > 0 ? [`${gbp(hpCost)} heat pump`] : []),
  ] : [];
  $('cards').innerHTML = `
    ${card('Current tariff', gbp(cur.total), cur.source === 'manual'
      ? `manual · ${cur.impliedRate.toFixed(2)} p/kWh + ${(p.curScPerDay || 0).toFixed(2)} p/day`
      : `from your CSV · ${cur.impliedRate.toFixed(2)} p/kWh implied`)}
    ${card(withBat.pvKwh > 0 ? 'Tariff, solar only' : 'Tariff, no battery', gbp(noBat.total),
           `energy ${gbp(noBat.energy)} + standing ${gbp(noBat.sc)}`)}
    ${card('With battery', gbp(withBat.total), `energy ${gbp(withBat.energy)} + standing ${gbp(withBat.sc)}`)}
    ${withBat.pvKwh > 0 ? card('Solar', `${withBat.pvKwh.toFixed(0)} kWh`,
      `${(100 * withBat.pvToHouse / withBat.pvKwh).toFixed(0)}% used directly · ` +
      `${(100 * withBat.pvToBattery / withBat.pvKwh).toFixed(0)}% stored · ` +
      `${(100 * withBat.pvExport / withBat.pvKwh).toFixed(0)}% exported · ` +
      `${(100 * withBat.pvSpill / withBat.pvKwh).toFixed(0)}% spilled`) : ''}
    ${card('Saving vs current', gbp(save), `${gbp(withBat.savedVsNoBattery)} of it from the battery` +
           (withBat.wearP > 0 ? `<br>${gbp(save - withBat.wear)} net of battery wear` : ''),
           save >= 0 ? 'pos' : 'neg')}
    ${withBat.wearP > 0 ? card('Battery wear', `${gbp(withBat.wear * annual)}/yr`,
      `${withBat.wearP.toFixed(2)} p per kWh stored · ${(withBat.stored / withBat.usableCap * annual).toFixed(0)} cycles/yr ` +
      `→ ${(p.cycleLife / (withBat.stored / withBat.usableCap * annual)).toFixed(0)} yrs to ${p.cycleLife.toLocaleString('en-GB')} cycles`) : ''}
    ${invest > 0 ? card('Payback', fmtYears(pbCur) + fmtRoi(roiCur), [
      (costParts.length ? costParts.join(' + ') : gbp(invest)) +
        ` ÷ ${gbp(pbSave)}/yr vs your current setup`,
      ...(gasBill > 0 ? [`incl. ${gbp(gasBill * annual)}/yr gas bill removed`] : []),
      ...(p.escPct > 0 ? [`prices rising ${p.escPct}%/yr — ROI is the year-1 floor`] : []),
      ...(pbBatt !== null ? [`${fmtYears(pbBatt)}${fmtRoi(roiBatt)} counting only what the battery adds`] : []),
    ].join(' · ')) : ''}
  `;

  const w = [...prices.warnings];
  if (withBat.socViolations) w.push(`${withBat.socViolations} state-of-charge bound violations — please report this.`);
  if (p.hpMode === 'gas' && hpInfo?.unmatchedKwh > 0.5) {
    w.push(`${hpInfo.unmatchedKwh.toFixed(0)} kWh of gas fell outside the electricity date range and was ignored.`);
  }
  if (p.hpMode === 'gas' && hpInfo?.coveredDays < 0.9 * withBat.nDays) {
    w.push(`Gas CSV covers ${hpInfo.coveredDays} of ${Math.round(withBat.nDays)} days — ` +
           'gas bill credit may be understated.');
  }
  if (hpCost > 0 && p.hpMode === 'synthetic') {
    w.push('Synthetic heat pump: no gas bill credit — payback counts the heat pump cost ' +
           'but not the gas saving. Use a gas CSV for the full ledger.');
  }
  if (hpCost > 0 && p.hpMode === 'gas' && !(gasRate > 0)) {
    w.push('No gas unit rate given or derivable from the gas CSV — payback counts the ' +
           'heat pump cost but no gas bill credit.');
  }
  $('warnings').innerHTML = w.map((x) => `<div class="warn">${x}</div>`).join('');

  const m = prices.meta;
  $('statsNote').innerHTML =
    `${withBat.kwh.toLocaleString('en-GB', { maximumFractionDigits: 0 })} kWh over ${withBat.nDays.toFixed(2)} days` +
    (hpInfo ? ` (includes ${hpInfo.hpKwh.toFixed(0)} kWh heat pump)` : '') +
    ` · import ${m.impMin.toFixed(2)}–${m.impMax.toFixed(2)}p, mean ${m.impMean.toFixed(2)}p, ${m.negSlots} negative slots` +
    ` · standing charge ${m.scPerDay.toFixed(3)} p/day${m.scDistinct > 1 ? ` (${m.scDistinct} rate periods)` : ''}` +
    `<br>battery active ${withBat.batteryDays}/${withBat.dayCount} days · ` +
    `${withBat.cycled.toFixed(0)} kWh/yr through the pack · mean ${withBat.meanThroughput.toFixed(1)} kWh/day ` +
    `(${withBat.utilisation.toFixed(0)}% of ${withBat.usableCap.toFixed(1)} kWh usable) · ` +
    `${(withBat.cycled / p.capacity).toFixed(0)} full-equivalent cycles/yr` +
    (withBat.warmupDays ? ` · first ${withBat.warmupDays} days are forecast warm-up (cold start)` : '') +
    (p.exportLimitKw ? ` · max export ${(withBat.maxExportSlot * 2).toFixed(2)} kW vs ${p.exportLimitKw} kW G100 limit` : '');

  buildDayIndex();
  renderMonths();
  if (!state.flow) state.flow = new FlowDiagram($('flow'));
  selectDay($('daySelect').value || withBat.perDay[0].day);
}

const card = (k, v, d, cls = '') =>
  `<div class="card"><div class="k">${k}</div><div class="v ${cls}">${v}</div><div class="d">${d}</div></div>`;

const systemCost = (p) => (p.batteryCost || 0) + (p.inverterCost || 0) + (p.installCost || 0) + (p.solarCost || 0);
const fmtYears = (y) => (y === null ? '—' : y > 99 ? '>99 yrs' : `${y.toFixed(1)} yrs`);

function renderCompare(rows, cur, cost = 0, escPct = 0) {
  $('intro').classList.add('hide');
  $('results').classList.remove('hide');
  if (!WIDE()) $('controls').open = false;
  $('comparePanel').classList.remove('hide');
  rows.sort((a, b) => a.wb.total - b.wb.total);
  const best = rows[0];
  $('compareTable').innerHTML =
    `<thead><tr><th>Import</th><th>Export</th><th>No battery</th><th>With battery</th>
      <th>Saves vs current</th><th>Battery adds</th><th>Payback</th><th>kWh cycled</th></tr></thead><tbody>` +
    rows.map((r) => `<tr class="${r === best ? 'best' : ''}">
      <td title="${r.note.replace(/"/g, '&quot;')}">${IMPORT_TARIFFS[r.ik].name}</td>
      <td>${r.ek === 'none' ? '—' : EXPORT_TARIFFS[r.ek].name}</td>
      <td>${gbp(r.nb.total)}</td><td><b>${gbp(r.wb.total)}</b></td>
      <td class="${cur.total - r.wb.total >= 0 ? 'pos' : 'neg'}">${gbp(cur.total - r.wb.total)}</td>
      <td>${gbp(r.wb.savedVsNoBattery)}</td>
      <td>${fmtYears(paybackYears(cost, (cur.total - r.wb.total) * 365 / r.wb.nDays, escPct))}</td>
      <td>${r.wb.cycled.toFixed(0)}</td></tr>`).join('') +
    `</tbody><tfoot><tr><td>Current tariff</td><td>—</td><td>${gbp(cur.total)}</td>
      <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td></tr></tfoot>`;
}

function renderMonths() {
  const { withBat, noBat } = state.run;
  const by = new Map();
  withBat.perDay.forEach((d, i) => {
    const k = d.day.slice(0, 7);
    if (!by.has(k)) by.set(k, { kwh: 0, base: 0, cost: 0, out: 0, pv: 0 });
    const o = by.get(k);
    o.kwh += d.kwh; o.base += d.baseP / 100; o.cost += d.costP / 100; o.out += d.kwhOut;
    o.pv += d.pv || 0;
  });
  const solar = withBat.pvKwh > 0;                 // no solar, no column
  $('monthTable').innerHTML =
    `<thead><tr><th>Month</th><th>kWh</th>${solar ? '<th>Solar kWh</th>' : ''}
      <th>No battery</th><th>With battery</th>
      <th>Saved</th><th>kWh cycled</th></tr></thead><tbody>` +
    [...by.entries()].map(([k, o]) => `<tr><td>${k}</td>
      <td>${o.kwh.toFixed(0)}</td>${solar ? `<td>${o.pv.toFixed(0)}</td>` : ''}
      <td>${gbp(o.base)}</td><td>${gbp(o.cost)}</td>
      <td class="pos">${gbp(o.base - o.cost)}</td><td>${o.out.toFixed(0)}</td></tr>`).join('') +
    '</tbody>';
}

// ------------------------------------------------------------------ day explorer

function buildDayIndex() {
  const { withBat } = state.run;
  state.dayIndex = new Map();
  withBat.slots.forEach((s) => {
    if (!s) return;
    if (!state.dayIndex.has(s.day)) state.dayIndex.set(s.day, []);
    state.dayIndex.get(s.day).push(s);
  });
  const sel = $('daySelect');
  const keep = sel.value;
  sel.innerHTML = '';
  withBat.perDay.forEach((d) => {
    sel.append(new Option(`${d.day} — saves ${gbp(d.savedP / 100)}`, d.day));
  });
  if (keep && state.dayIndex.has(keep)) sel.value = keep;
}

$('daySelect').onchange = () => selectDay($('daySelect').value);
$('dayPreset').onchange = () => {
  const { withBat } = state.run;
  const days = withBat.perDay;
  let pick;
  if ($('dayPreset').value === 'best') pick = days.reduce((a, b) => (b.savedP > a.savedP ? b : a));
  else if ($('dayPreset').value === 'worst') pick = days.reduce((a, b) => (b.savedP < a.savedP ? b : a));
  else if ($('dayPreset').value === 'mostcycled') pick = days.reduce((a, b) => (b.kwhOut > a.kwhOut ? b : a));
  else {
    let bestDay = null, bestVal = null;
    for (const [day, slots] of state.dayIndex) {
      const v = $('dayPreset').value === 'cheap'
        ? Math.min(...slots.map((s) => s.imp)) : Math.max(...slots.map((s) => s.imp));
      if (bestVal === null || ($('dayPreset').value === 'cheap' ? v < bestVal : v > bestVal)) {
        bestVal = v; bestDay = day;
      }
    }
    pick = { day: bestDay };
  }
  $('daySelect').value = pick.day;
  selectDay(pick.day);
};

function selectDay(day) {
  const slots = state.dayIndex.get(day);
  if (!slots) return;
  state.daySlots = slots;
  $('slotSlider').max = slots.length - 1;
  const ts = $('slotSelect');
  ts.innerHTML = '';
  slots.forEach((s, i) => ts.append(new Option(s.hhmm, i)));
  const d = state.run.withBat.perDay.find((x) => x.day === day);
  $('dayNote').innerHTML =
    `${d.kwh.toFixed(2)} kWh used · no battery ${gbp(d.baseP / 100)} · with battery ` +
    `${gbp(d.costP / 100)} · <b>saved ${gbp(d.savedP / 100)}</b>` +
    (d.window ? ` · charge window ${d.window[0]}–${d.window[1]}` : ' · battery unused') +
    ` · ${d.kwhOut.toFixed(1)} kWh through the pack` +
    ` · ${slots.length} slots${slots.length !== 48 ? ' (DST day)' : ''}`;
  drawDayChart(slots);
  showSlot(Math.min(Number($('slotSlider').value), slots.length - 1));
}

$('slotSlider').oninput = () => showSlot(Number($('slotSlider').value));
$('slotSelect').onchange = () => showSlot(Number($('slotSelect').value));

function showSlot(i) {
  const s = state.daySlots[i];
  if (!s) return;
  $('slotSlider').value = i;
  $('slotSelect').value = i;
  $('slotTime').textContent = s.hhmm;
  state.flow.update(s, state.run.p.capacity);
  $('slotTable').innerHTML = `
    ${trow('Import price', `${s.imp.toFixed(2)} p/kWh`)}
    ${trow('Export price', `${s.exp.toFixed(2)} p/kWh`)}
    ${trow('House load', `${s.load.toFixed(3)} kWh (${(s.load * 2).toFixed(2)} kW)`)}
    ${s.pvGen > 1e-9 ? trow('Solar', `${s.pvGen.toFixed(3)} kWh · ` +
      `${Math.max(0, s.pvToHouse).toFixed(2)} house / ${s.pvToBattery.toFixed(2)} battery / ` +
      `${s.pvExport.toFixed(2)} export` +
      `${s.pvSpill > 1e-9 ? ` / ${s.pvSpill.toFixed(2)} spilled` : ''}`) : ''}
    ${trow('Battery charge', s.chg > 1e-9 ? `${s.chg.toFixed(3)} kWh from grid` : '—')}
    ${trow('Battery → house', s.disLoad > 1e-9 ? `${s.disLoad.toFixed(3)} kWh` : '—')}
    ${trow('Battery → export', s.disExp > 1e-9 ? `${s.disExp.toFixed(3)} kWh` : '—')}
    ${trow('Grid import', `${s.gridImp.toFixed(3)} kWh`)}
    ${trow('Grid export', s.gridExp > 1e-9 ? `${s.gridExp.toFixed(3)} kWh` : '—')}
    ${trow('State of charge', `${s.soc.toFixed(2)} kWh (${s.socPct.toFixed(0)}%)`)}
    ${trow('Slot cost', `${s.costP >= 0 ? '' : '−'}${Math.abs(s.costP).toFixed(2)}p`)}`;
  const cur = document.getElementById('cursor');
  if (cur) cur.setAttribute('x', 40 + (420 / state.daySlots.length) * i);
}
const trow = (k, v) => `<tr><td class="dimtd">${k}</td><td>${v}</td></tr>`;

$('play').onclick = () => {
  if (state.timer) {
    clearInterval(state.timer); state.timer = null; $('play').textContent = '▶ Play';
    return;
  }
  $('play').textContent = '❚❚ Pause';
  state.timer = setInterval(() => {
    let i = Number($('slotSlider').value) + 1;
    if (i > state.daySlots.length - 1) {
      const days = state.run.withBat.perDay;
      const cur = days.findIndex((d) => d.day === $('daySelect').value);
      const next = days[cur + 1];
      if (!next) {                                  // end of the data — stop playback
        clearInterval(state.timer); state.timer = null; $('play').textContent = '▶ Play';
        return;
      }
      $('daySelect').value = next.day;
      selectDay(next.day);
      i = 0;
    }
    showSlot(i);
  }, 320);
};

function drawDayChart(slots) {
  const W = 480, H = 190, L = 40, R = 460, T = 12, B = 160;
  const n = slots.length;
  const imps = slots.map((s) => s.imp), exps = slots.map((s) => s.exp);
  const lo = Math.min(0, ...imps, ...exps), hi = Math.max(...imps, ...exps, 1);
  const x = (i) => L + ((R - L) / n) * (i + 0.5);
  const y = (v) => B - ((v - lo) / (hi - lo)) * (B - T);
  const cap = state.run.p.capacity;
  const ys = (v) => B - (v / cap) * (B - T);

  const path = (vals, fn) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${fn(v).toFixed(1)}`).join('');
  const socPath = `M${x(0)},${B} ` + slots.map((s, i) => `L${x(i).toFixed(1)},${ys(s.soc).toFixed(1)}`).join(' ') + ` L${x(n - 1)},${B} Z`;
  // The planned SOC is in the hover readout, not drawn: a third dashed line made the
  // panel unreadable. (In contiguous mode it steps at a charge window's first slot, a
  // display artefact of the plan crediting the whole window there.)
  // House load and PV share one half-hourly kWh scale, drawn against the day's own peak
  // in the lower 60% of the panel: both are far smaller than the pack's kWh.
  const kwhMax = Math.max(1e-9, ...slots.map((s) => Math.max(s.load, s.pvGen || 0, s.pvFc || 0)));
  const yp = (v) => B - (v / kwhMax) * (B - T) * 0.6;
  const hasPv = slots.some((s) => (s.pvGen || 0) > 1e-6 || (s.pvFc || 0) > 1e-6);
  const pvPath = hasPv ? `M${x(0)},${B} ` + slots.map((s, i) => `L${x(i).toFixed(1)},${yp(s.pvGen || 0).toFixed(1)}`).join(' ') + ` L${x(n - 1)},${B} Z` : '';
  const pvFcPath = hasPv ? slots.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${yp(s.pvFc || 0).toFixed(1)}`).join('') : '';
  const loadPath = path(slots.map((s) => s.load), yp);

  const bars = slots.map((s, i) => {
    const w = (R - L) / n - 1;
    if (s.chg > 1e-9) return `<rect x="${x(i) - w / 2}" y="${B}" width="${w}" height="${Math.min(28, s.chg * 9)}" fill="var(--acc)" opacity=".55"/>`;
    const d = s.disLoad + s.disExp;
    if (d > 1e-9) return `<rect x="${x(i) - w / 2}" y="${B}" width="${w}" height="${Math.min(28, d * 9)}" fill="var(--batt)" opacity=".55"/>`;
    if (s.pvExport > 1e-9) return `<rect x="${x(i) - w / 2}" y="${B}" width="${w}" height="${Math.min(28, s.pvExport * 9)}" fill="var(--sun)" opacity=".55"/>`;
    return '';
  }).join('');

  $('dayChart').innerHTML = `
    <line x1="${L}" y1="${y(0)}" x2="${R}" y2="${y(0)}" stroke="var(--line)"/>
    ${pvPath ? `<path d="${pvPath}" fill="var(--sun)" opacity=".22"/>` +
      `<path d="${pvFcPath}" fill="none" stroke="var(--sun)" stroke-width="1" stroke-dasharray="3 3" opacity=".8"/>` : ''}
    <path d="${socPath}" fill="var(--batt)" opacity=".16"/>
    <path d="${loadPath}" fill="none" stroke="var(--fg)" stroke-width="1.4" opacity=".7"/>
    <path d="${path(exps, y)}" fill="none" stroke="var(--good)" stroke-width="1.6" opacity=".85"/>
    <path d="${path(imps, y)}" fill="none" stroke="var(--acc)" stroke-width="1.9"/>
    ${bars}
    <rect id="cursor" x="${L}" y="${T}" width="2" height="${B - T + 30}" fill="var(--fg)" opacity=".55"/>
    <text x="4" y="${y(hi)}" fill="var(--dim)" font-size="10">${hi.toFixed(0)}p</text>
    <text x="4" y="${y(lo) + 4}" fill="var(--dim)" font-size="10">${lo.toFixed(0)}p</text>
    <text x="${L}" y="${H - 4}" fill="var(--dim)" font-size="10">${slots[0].hhmm}</text>
    <text x="${R - 30}" y="${H - 4}" fill="var(--dim)" font-size="10">${slots[n - 1].hhmm}</text>
    <text x="${(L + R) / 2 - 40}" y="${H - 4}" fill="var(--dim)" font-size="10">bars = battery activity</text>
    <g id="hoverG" visibility="hidden" pointer-events="none">
      <rect id="hoverLine" x="${L}" y="${T}" width="1.2" height="${B - T}" fill="var(--fg)" opacity=".8"/>
      <rect id="hoverBg" x="0" y="${T}" width="124" height="64" rx="3" fill="var(--panel2, #000)" opacity=".9"/>
      <text id="hoverTime" y="${T + 12}" fill="var(--fg)" font-size="10"></text>
      <text id="hoverImp" y="${T + 24}" fill="var(--acc)" font-size="10"></text>
      <text id="hoverExp" y="${T + 36}" fill="var(--good)" font-size="10"></text>
      <text id="hoverLoad" y="${T + 48}" fill="var(--fg)" font-size="10"></text>
      <text id="hoverSoc" y="${T + 60}" fill="var(--batt)" font-size="10"></text>
    </g>`;
}

// Hover readout: vertical line + prices, house load and actual/planned SOC at the
// pointer's slot.
// Listeners live on the SVG (kept across redraws); the group is per-draw, so
// look it up each event. Snaps to slot centres, flips sides past halfway.
$('dayChart').addEventListener('pointermove', (e) => {
  const g = document.getElementById('hoverG');
  const n = state.daySlots.length;
  if (!g || !n) return;
  const r = $('dayChart').getBoundingClientRect();
  const i = slotAtX((e.clientX - r.left) * (480 / r.width), n);
  const s = state.daySlots[i];
  const cx = 40 + (420 / n) * (i + 0.5);
  const left = cx <= 250;
  document.getElementById('hoverLine').setAttribute('x', cx - 0.6);
  const bg = document.getElementById('hoverBg');
  bg.setAttribute('x', left ? cx + 4 : cx - 128);
  const cap = state.run.p.capacity;
  const soc = `soc ${s.soc.toFixed(1)}` + (Number.isFinite(s.plannedSoc)
    ? ` · plan ${Math.min(s.plannedSoc, cap).toFixed(1)} kWh` : ' kWh');
  for (const [id, text] of [['hoverTime', s.hhmm],
                            ['hoverImp', `imp ${s.imp.toFixed(2)} p/kWh`],
                            ['hoverExp', `exp ${s.exp.toFixed(2)} p/kWh`],
                            ['hoverLoad', `load ${s.load.toFixed(2)} kWh`],
                            ['hoverSoc', soc]]) {
    const t = document.getElementById(id);
    t.setAttribute('x', left ? cx + 9 : cx - 123);
    t.textContent = text;
  }
  g.setAttribute('visibility', 'visible');
});
$('dayChart').addEventListener('pointerleave', () => {
  const g = document.getElementById('hoverG');
  if (g) g.setAttribute('visibility', 'hidden');
});
