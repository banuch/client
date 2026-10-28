// Meter tabs over stored history: value trends, load profiles, billing,
// events, read cycles and the device log. They load when opened or when the
// operator changes a filter or presses Refresh, never on the automatic timer.
//
// Profile row times (t) are the meter's local time as text; ranges for them
// are built in the display time zone (meters and server zone are the same).
import { api, devicePath, query, serverNow } from '../api.js';
import { int, meterNum, withUnit, dateTime, dateMinute, durationText, meterTimeText, localInputToMs, msToLocalInput, bytesText } from '../format.js';
import { esc, stateBox, errorBox, skeletonRows, emptyRow, pager, retBadge, signedBadge, chartTheme, downloadCsv, icon } from '../ui.js';
import { O, PROFILE, EVENT_CATEGORIES } from '../obis.js';

const PAGE_SIZE = 50;
const WIDE_COLS = 16;       // wider profiles are shown one line per column
const WIDE_ROWS = 13;       // ... with this many newest entries side by side
const MAX_POINTS_TABLE = 300;

// Runs one request at a time per tab; a newer request cancels the older one.
function requestRunner() {
  let controller = null;
  return (outer, fn) => {
    controller?.abort();
    controller = new AbortController();
    const own = controller;
    outer?.addEventListener('abort', () => own.abort(), { once: true });
    return fn(own.signal);
  };
}

function segmented(attr, options, active) {
  return `<div class="segmented" role="group">${options.map(([value, label]) => `<button type="button" data-${attr}="${esc(value)}" class="${String(value) === String(active) ? 'active' : ''}">${esc(label)}</button>`).join('')}</div>`;
}

const cellText = (v) => (v === null || v === undefined ? '—' : typeof v === 'number' ? meterNum(v, 4) : v);
const colLabel = (c) => (c.unit ? `${c.name || c.obis} (${c.unit})` : (c.name || c.obis));
const dPart = (obis) => Number(obis.split('.')[3]);
const isEnergyUnit = (unit) => /h$/i.test(unit || '');

// One Chart.js chart per tab; recreated on each render.
function drawChart(holder, { labels, series, bar = false, unit = '' }) {
  if (!window.Chart) {
    holder.innerHTML = stateBox({ kind: 'error', title: 'Chart library did not load' });
    return null;
  }
  holder.innerHTML = '<canvas role="img" aria-label="Chart"></canvas>';
  const t = chartTheme();
  const palette = series.length === 3 && series.every((s) => s.phase) ? t.phases : [t.accent, ...t.extra];
  return new window.Chart(holder.querySelector('canvas'), {
    type: bar ? 'bar' : 'line',
    data: {
      labels,
      datasets: series.map((s, i) => ({
        label: s.label,
        data: s.data,
        borderColor: palette[i % palette.length],
        backgroundColor: bar ? palette[i % palette.length] : `${palette[i % palette.length]}22`,
        fill: !bar && series.length === 1,
        borderWidth: bar ? 0 : 2,
        tension: 0.2,
        pointRadius: labels.length > 60 ? 0 : 2,
        spanGaps: false,
      })),
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { intersect: false, mode: 'index' },
      scales: {
        x: { ticks: { maxTicksLimit: 8, color: t.muted, maxRotation: 0 }, grid: { display: false } },
        y: { ticks: { color: t.muted }, grid: { color: t.grid }, title: { display: Boolean(unit), text: unit, color: t.muted } },
      },
      plugins: { legend: { align: 'end', labels: { color: t.text, boxWidth: 10, boxHeight: 10 } } },
    },
  });
}

const csvName = (id, what) => `${id}-${what}-${meterTimeText(serverNow()).slice(0, 10)}.csv`;

// ------------------------------------------------------------------ trends
const TREND_PRESETS = [
  ['voltage', 'Voltage R/Y/B', [O.vR, O.vY, O.vB], [O.v], true],
  ['current', 'Current R/Y/B', [O.iR, O.iY, O.iB], [O.i], true],
  ['pf', 'Power factor', [O.pfR, O.pfY, O.pfB, O.pf], [O.pf], false],
  ['power', 'Power (kW / kvar / kVA)', [O.kw, O.kvar, O.kva], [], false],
  ['frequency', 'Frequency', [O.freq], [], false],
  ['energy', 'Energy import (kWh / kVAh)', [O.kwh, O.kvah], [], false],
];

export function createTrendsTab({ id, latest: initial }) {
  const state = { preset: '', hours: 168 };
  let root;
  let latest = initial;
  let chart = null;
  let rows = [];
  let series = [];
  const run = requestRunner();

  function numericValues() {
    return (latest?.values || []).filter((v) => v.num !== null);
  }

  // Presets whose values the meter sends, then any other numeric value.
  function options() {
    const have = new Set(numericValues().map((v) => v.obis));
    const presets = [];
    for (const [key, label, list, fallback, phase] of TREND_PRESETS) {
      let obis = list.filter((o) => have.has(o));
      if (!obis.length) obis = fallback.filter((o) => have.has(o));
      if (obis.length) presets.push({ key, label, obis, phase: phase && obis.length === 3 });
    }
    const singles = numericValues().map((v) => ({ key: `v:${v.obis}`, label: `${v.name || v.obis} (${v.obis})`, obis: [v.obis] }));
    return { presets, singles };
  }

  function range() {
    if (state.hours) return { from: serverNow() - state.hours * 3600000, to: '' };
    return { from: localInputToMs(root.querySelector('#tFrom').value) ?? '', to: localInputToMs(root.querySelector('#tTo').value) ?? '' };
  }

  function renderControls() {
    const { presets, singles } = options();
    const all = [...presets, ...singles];
    if (!all.some((o) => o.key === state.preset)) state.preset = all[0]?.key || '';
    root.querySelector('#tPreset').innerHTML = (presets.length ? `<optgroup label="Groups">${presets.map((o) => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join('')}</optgroup>` : '')
      + `<optgroup label="Single value">${singles.map((o) => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join('')}</optgroup>`;
    root.querySelector('#tPreset').value = state.preset;
    root.querySelectorAll('[data-hours]').forEach((b) => b.classList.toggle('active', Number(b.dataset.hours) === state.hours));
    root.querySelector('#tCustom').classList.toggle('hidden', state.hours !== 0);
    return all.find((o) => o.key === state.preset);
  }

  function render(option) {
    const box = root.querySelector('.chart-box');
    const table = root.querySelector('#tTable');
    chart?.destroy();
    chart = null;
    if (!rows.length) {
      box.innerHTML = stateBox({ title: 'No values in this range', detail: 'Choose a longer range. Values are stored once per read cycle.' });
      table.innerHTML = '';
      root.querySelector('.chart-note').textContent = '';
      return;
    }
    const units = [...new Set(series.map((s) => s.unit).filter(Boolean))];
    chart = drawChart(box, {
      labels: rows.map((r) => dateMinute(r.readAt)),
      series: series.map((s) => ({ label: `${s.name}${s.unit ? ` (${s.unit})` : ''}`, data: rows.map((r) => r.values[s.obis] ?? null), phase: option.phase })),
      unit: units.length === 1 ? units[0] : '',
    });
    root.querySelector('.chart-note').textContent = `${rows.length} read cycles` + (rows.length >= 5000 ? ' (newest 5000)' : '');
    const shown = rows.slice(-MAX_POINTS_TABLE).reverse();
    table.innerHTML = `<table><thead><tr><th>Read at</th>${series.map((s) => `<th class="num">${esc(s.name)}${s.unit ? ` (${esc(s.unit)})` : ''}</th>`).join('')}</tr></thead>
      <tbody>${shown.map((r) => `<tr><td>${esc(dateTime(r.readAt))}</td>${series.map((s) => `<td class="num">${esc(meterNum(r.values[s.obis], 4))}</td>`).join('')}</tr>`).join('')}</tbody></table>
      ${rows.length > shown.length ? `<div class="chart-note">Table shows the newest ${shown.length}; the CSV has all ${rows.length}.</div>` : ''}`;
  }

  async function load(signal) {
    const option = renderControls();
    if (!option) {
      root.querySelector('.chart-box').innerHTML = stateBox({ kind: 'info', title: 'No numeric values yet', detail: 'Trends appear after the first meter reading.' });
      return;
    }
    const { from, to } = range();
    const box = root.querySelector('.chart-box');
    if (!box.querySelector('canvas')) box.innerHTML = '<span class="skeleton block"></span>';
    try {
      await run(signal, async (s) => {
        const results = await Promise.all(option.obis.map((obis) => api(devicePath(id, `/readings${query({ obis, from, to, limit: 5000 })}`), { signal: s })));
        const byTime = new Map();
        series = option.obis.map((obis, i) => {
          const latestValue = latest.values.find((v) => v.obis === obis);
          for (const r of results[i]) {
            if (!byTime.has(r.readAt)) byTime.set(r.readAt, { readAt: r.readAt, values: {} });
            byTime.get(r.readAt).values[obis] = r.num;
          }
          return { obis, name: latestValue?.name || obis, unit: results[i][0]?.unit ?? latestValue?.unit ?? '' };
        });
        rows = [...byTime.values()].sort((a, b) => a.readAt - b.readAt);
        render(option);
      });
    } catch (error) {
      if (error.name !== 'AbortError') box.innerHTML = errorBox(error);
      throw error;
    }
  }

  return {
    mount(element) {
      root = element;
      root.innerHTML = `<div class="toolbar">
          <label class="field">Values<select id="tPreset"></select></label>
          <label class="field">Range ${segmented('hours', [[24, '24 h'], [168, '7 days'], [720, '30 days'], [0, 'Custom']], state.hours)}</label>
          <span id="tCustom" class="chips hidden"><label class="field">From<input id="tFrom" type="datetime-local"></label><label class="field">To<input id="tTo" type="datetime-local"></label></span>
          <span class="spacer"></span>
          <button class="btn small" type="button" data-action="csv">${icon('download')}CSV</button>
        </div>
        <div class="chart-box"></div><div class="chart-note"></div>
        <div class="tscroll tall" id="tTable"></div>`;
      root.querySelector('#tFrom').value = msToLocalInput(serverNow() - 86400000);
      root.querySelector('#tPreset').addEventListener('change', (e) => { state.preset = e.target.value; load().catch(() => {}); });
      root.querySelectorAll('#tFrom, #tTo').forEach((input) => input.addEventListener('change', () => load().catch(() => {})));
      root.addEventListener('click', (e) => {
        const h = e.target.closest('[data-hours]');
        if (h) {
          state.hours = Number(h.dataset.hours);
          load().catch(() => {});
        }
        if (e.target.closest('[data-action=csv]') && rows.length) {
          downloadCsv(csvName(id, 'trend'), ['read_at', ...series.map((s) => `${s.name} (${s.unit})`)],
            rows.map((r) => [dateTime(r.readAt), ...series.map((s) => r.values[s.obis] ?? '')]));
        }
        if (e.target.closest('[data-action=retry]')) load().catch(() => {});
      });
    },
    setLatest(value) { latest = value; },
    load,
    destroy() { chart?.destroy(); },
  };
}

// ---------------------------------------------------------------- profiles
const isEventProfile = (obis) => obis.startsWith('0.0.99.98.');
const PHASE_GROUPS = [
  ['Avg voltage R/Y/B', ['1.0.32.27.0.255', '1.0.52.27.0.255', '1.0.72.27.0.255']],
  ['Avg current R/Y/B', ['1.0.31.27.0.255', '1.0.51.27.0.255', '1.0.71.27.0.255']],
];

// Chart metrics for one profile: phase groups, numeric columns, and for
// cumulative energy registers (D = 8, daily profile) the change per row.
function profileMetrics(p) {
  const numeric = p.cols.map((c, i) => ({ ...c, i })).filter((c) => p.rows.some((r) => typeof r.c[c.i] === 'number'));
  const out = [];
  for (const [label, obis] of PHASE_GROUPS) {
    const cols = obis.map((o) => numeric.find((c) => c.obis === o));
    if (cols.every(Boolean)) out.push({ key: `g:${label}`, label: `${label} (${cols[0].unit})`, cols, phase: true, unit: cols[0].unit });
  }
  for (const c of numeric) {
    if (dPart(c.obis) === 8) out.push({ key: `d:${c.i}`, label: `${c.name} per period (${c.unit})`, cols: [c], delta: true, bar: true, unit: c.unit });
  }
  for (const c of numeric) out.push({ key: `c:${c.i}`, label: colLabel(c), cols: [c], bar: isEnergyUnit(c.unit) && dPart(c.obis) !== 8, unit: c.unit });
  return out;
}

export function createProfilesTab({ id }) {
  const state = { obis: '', days: 7, metric: '', page: 1 };
  let root;
  let list = [];
  let profile = null;
  let chart = null;
  const run = requestRunner();

  function rangeQuery(info) {
    if (!info?.lastT) return {};            // untimed profiles (name plate) ignore the range
    if (state.days > 0) return { from: meterTimeText(serverNow() - state.days * 86400000) };
    if (state.days === 0) return { from: root.querySelector('#pFrom').value, to: root.querySelector('#pTo').value };
    return {};
  }

  function renderControls() {
    root.querySelector('#pProfiles').innerHTML = segmented('profile', list.map((p) => [p.obis, `${p.name || p.obis} (${int(p.rowCount)})`]), state.obis);
    root.querySelectorAll('[data-days]').forEach((b) => b.classList.toggle('active', Number(b.dataset.days) === state.days));
    root.querySelector('#pCustom').classList.toggle('hidden', state.days !== 0);
  }

  function renderChart() {
    const box = root.querySelector('.chart-box');
    const select = root.querySelector('#pMetric');
    chart?.destroy();
    chart = null;
    const timed = profile.rows.filter((r) => r.t).slice().reverse();     // oldest first
    const metrics = timed.length > 1 ? profileMetrics({ cols: profile.cols, rows: timed }) : [];
    root.querySelector('#pMetricField').classList.toggle('hidden', !metrics.length);
    box.classList.toggle('hidden', !metrics.length);
    if (!metrics.length) return;
    if (!metrics.some((m) => m.key === state.metric)) state.metric = metrics[0].key;
    select.innerHTML = metrics.map((m) => `<option value="${esc(m.key)}">${esc(m.label)}</option>`).join('');
    select.value = state.metric;
    const metric = metrics.find((m) => m.key === state.metric);
    let points = timed;
    let data = metric.cols.map((c) => timed.map((r) => (typeof r.c[c.i] === 'number' ? r.c[c.i] : null)));
    if (metric.delta) {
      // Change from the previous row; the first row has no previous one.
      data = data.map((values) => values.slice(1).map((v, i) => (v !== null && values[i] !== null ? v - values[i] : null)));
      points = timed.slice(1);
    }
    const daily = profile.obis === PROFILE.daily;
    chart = drawChart(box, {
      labels: points.map((r) => (daily ? r.t.slice(0, 10) : r.t.slice(5, 16))),
      series: metric.cols.map((c, i) => ({ label: metric.cols.length > 1 ? `${'RYB'[i]} phase` : metric.label, data: data[i].map((v) => (v === null ? null : Number(v.toFixed(4)))), phase: metric.phase })),
      bar: metric.bar,
      unit: metric.unit,
    });
  }

  function renderTable() {
    const wrap = root.querySelector('#pTable');
    const pagerBox = root.querySelector('.pager');
    const { cols, rows } = profile;
    if (!rows.length) {
      wrap.innerHTML = stateBox({ title: 'No rows in this range', detail: 'Choose a longer range or All.' });
      pagerBox.innerHTML = '';
      return;
    }
    if (cols.length > WIDE_COLS) {
      const shown = rows.slice(0, WIDE_ROWS);
      wrap.innerHTML = `<table class="pivot"><thead><tr><th>Column</th>${shown.map((r) => `<th class="num">${esc(r.t || dateTime(r.receivedAt))}</th>`).join('')}</tr></thead>
        <tbody>${cols.map((c, i) => `<tr><td title="${esc(c.obis)}">${esc(colLabel(c))}</td>${shown.map((r) => `<td class="num">${esc(cellText(r.c[i]))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      pagerBox.innerHTML = `<span>${rows.length} entries${rows.length > shown.length ? `, newest ${shown.length} shown (CSV has all)` : ''}</span>`;
      return;
    }
    const hasEvents = rows.some((r) => r.e);
    const page = rows.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
    wrap.innerHTML = `<table><thead><tr>${cols.map((c) => `<th class="${c.unit ? 'num' : ''}" title="${esc(c.obis)}">${esc(colLabel(c))}</th>`).join('')}${hasEvents ? '<th>Event</th>' : ''}</tr></thead>
      <tbody>${page.map((r) => `<tr>${cols.map((c, i) => `<td class="${typeof r.c[i] === 'number' ? 'num' : ''}">${esc(cellText(r.c[i]))}</td>`).join('')}${hasEvents ? `<td>${esc(r.e || '')}</td>` : ''}</tr>`).join('')}</tbody></table>`;
    pagerBox.innerHTML = pager(state.page, PAGE_SIZE, rows.length, 'rows');
  }

  async function load(signal) {
    const wrap = root.querySelector('#pTable');
    try {
      await run(signal, async (s) => {
        list = (await api(devicePath(id, '/profiles'), { signal: s }))
          .filter((p) => p.obis !== PROFILE.billing && !isEventProfile(p.obis))
          .sort((a, b) => (a.obis === PROFILE.block ? -1 : b.obis === PROFILE.block ? 1 : a.obis === PROFILE.daily ? -1 : b.obis === PROFILE.daily ? 1 : a.obis.localeCompare(b.obis)));
        if (!list.length) {
          root.querySelector('#pProfiles').innerHTML = '';
          root.querySelector('.chart-box').classList.add('hidden');
          wrap.innerHTML = stateBox({ kind: 'info', title: 'No load profile data yet', detail: 'Profiles arrive with firmware 2.0.2 and later, every 30 minutes by default.' });
          return;
        }
        if (!list.some((p) => p.obis === state.obis)) state.obis = list[0].obis;
        renderControls();
        const info = list.find((p) => p.obis === state.obis);
        if (!wrap.children.length) wrap.innerHTML = `<table><tbody>${skeletonRows(6)}</tbody></table>`;
        profile = await api(devicePath(id, `/profiles/${state.obis}${query({ ...rangeQuery(info), limit: 5000 })}`), { signal: s });
        state.page = Math.min(state.page, Math.max(1, Math.ceil(profile.rows.length / PAGE_SIZE)));
        renderChart();
        renderTable();
      });
    } catch (error) {
      if (error.name !== 'AbortError') wrap.innerHTML = errorBox(error);
      throw error;
    }
  }

  const reload = () => load().catch(() => {});

  return {
    mount(element) {
      root = element;
      root.innerHTML = `<div class="toolbar">
          <div id="pProfiles"></div>
          <label class="field">Range ${segmented('days', [[1, '24 h'], [7, '7 days'], [31, '31 days'], [-1, 'All'], [0, 'Custom']], state.days)}</label>
          <span id="pCustom" class="chips hidden"><label class="field">From<input id="pFrom" type="date"></label><label class="field">To<input id="pTo" type="date"></label></span>
          <label class="field" id="pMetricField">Chart<select id="pMetric"></select></label>
          <span class="spacer"></span>
          <button class="btn small" type="button" data-action="csv">${icon('download')}CSV</button>
        </div>
        <div class="chart-box"></div>
        <div class="tscroll tall" id="pTable"></div>
        <div class="pager"></div>`;
      root.querySelector('#pFrom').value = meterTimeText(serverNow() - 7 * 86400000).slice(0, 10);
      root.querySelector('#pTo').value = meterTimeText(serverNow()).slice(0, 10);
      root.querySelector('#pMetric').addEventListener('change', (e) => { state.metric = e.target.value; renderChart(); });
      root.querySelectorAll('#pFrom, #pTo').forEach((input) => input.addEventListener('change', reload));
      root.addEventListener('click', (e) => {
        const p = e.target.closest('[data-profile]');
        if (p) {
          state.obis = p.dataset.profile;
          state.page = 1;
          return reload();
        }
        const d = e.target.closest('[data-days]');
        if (d) {
          state.days = Number(d.dataset.days);
          state.page = 1;
          return reload();
        }
        const page = e.target.closest('[data-page]');
        if (page && !page.disabled) {
          state.page = Number(page.dataset.page);
          return renderTable();
        }
        if (e.target.closest('[data-action=csv]') && profile?.rows.length) {
          downloadCsv(csvName(id, (profile.name || profile.obis).replace(/\W+/g, '-').toLowerCase()),
            [...profile.cols.map(colLabel), 'event'], profile.rows.map((r) => [...profile.cols.map((c, i) => r.c[i] ?? ''), r.e || '']));
        }
        if (e.target.closest('[data-action=retry]')) reload();
      });
    },
    load,
    destroy() { chart?.destroy(); },
  };
}

// ----------------------------------------------------------------- billing
const BILLING_METRICS = [
  ['kwh', 'Active energy per billing period (kWh)', O.kwh, true],
  ['kvah', 'Apparent energy per billing period (kVAh)', O.kvah, true],
  ['mdkw', 'Maximum demand (kW)', O.mdKw, false],
  ['mdkva', 'Maximum demand (kVA)', O.mdKva, false],
  ['pf', 'Average power factor', '1.0.13.0.0.255', false],
];

export function createBillingTab({ id }) {
  const state = { metric: 'kwh' };
  let root;
  let profile = null;
  let chart = null;
  const run = requestRunner();

  // Value column (not the "... time" capture column) of an OBIS code.
  const colIndex = (obis) => profile.cols.findIndex((c) => c.obis === obis && !/ time$/.test(c.name));

  function renderChart() {
    const box = root.querySelector('.chart-box');
    chart?.destroy();
    chart = null;
    const rows = profile.rows.filter((r) => r.t).slice().reverse();      // oldest first
    const available = BILLING_METRICS.filter(([, , obis]) => colIndex(obis) >= 0);
    root.querySelector('#bMetricField').classList.toggle('hidden', !available.length || rows.length < 2);
    box.classList.toggle('hidden', !available.length || rows.length < 2);
    if (!available.length || rows.length < 2) return;
    if (!available.some(([key]) => key === state.metric)) state.metric = available[0][0];
    root.querySelector('#bMetric').innerHTML = available.map(([key, label]) => `<option value="${key}">${esc(label)}</option>`).join('');
    root.querySelector('#bMetric').value = state.metric;
    const [, label, obis, delta] = available.find(([key]) => key === state.metric);
    const i = colIndex(obis);
    const values = rows.map((r) => (typeof r.c[i] === 'number' ? r.c[i] : null));
    // Billing rows hold cumulative registers: consumption is the change from
    // the previous billing date. The newest row is the running period.
    const data = delta ? values.slice(1).map((v, n) => (v !== null && values[n] !== null ? Number((v - values[n]).toFixed(3)) : null)) : values;
    const labels = (delta ? rows.slice(1) : rows).map((r, n, all) => (n === all.length - 1 && r === profile.rows[0] ? `${r.t.slice(0, 10)} (running)` : r.t.slice(0, 10)));
    chart = drawChart(box, { labels, series: [{ label, data }], bar: true, unit: profile.cols[i].unit });
  }

  function renderTable() {
    const { cols, rows } = profile;
    const shown = rows.slice(0, WIDE_ROWS);
    root.querySelector('#bTable').innerHTML = `<table class="pivot"><thead><tr><th>Billing date</th>${shown.map((r, n) => `<th class="num">${esc(r.t || dateTime(r.receivedAt))}${n === 0 ? '<span class="sub">latest</span>' : ''}</th>`).join('')}</tr></thead>
      <tbody>${cols.map((c, i) => `<tr><td title="${esc(c.obis)}">${esc(colLabel(c))}</td>${shown.map((r) => `<td class="num">${esc(cellText(r.c[i]))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    root.querySelector('.pager').innerHTML = `<span>${rows.length} billing entries${rows.length > shown.length ? `, newest ${shown.length} shown (CSV has all)` : ''}</span>`;
  }

  async function load(signal) {
    const wrap = root.querySelector('#bTable');
    try {
      await run(signal, async (s) => {
        try {
          profile = await api(devicePath(id, `/profiles/${PROFILE.billing}?limit=500`), { signal: s });
        } catch (error) {
          if (error.status !== 404) throw error;
          profile = null;
        }
        if (!profile || !profile.rows.length) {
          root.querySelector('.chart-box').classList.add('hidden');
          root.querySelector('#bMetricField').classList.add('hidden');
          wrap.innerHTML = stateBox({ kind: 'info', title: 'No billing data yet', detail: 'The billing profile arrives with firmware 2.0.2 and later.' });
          return;
        }
        renderChart();
        renderTable();
      });
    } catch (error) {
      if (error.name !== 'AbortError') wrap.innerHTML = errorBox(error);
      throw error;
    }
  }

  return {
    mount(element) {
      root = element;
      root.innerHTML = `<div class="toolbar">
          <label class="field" id="bMetricField">Chart<select id="bMetric"></select></label>
          <span class="spacer"></span>
          <button class="btn small" type="button" data-action="csv">${icon('download')}CSV</button>
        </div>
        <div class="chart-box"></div>
        <div class="tscroll tall" id="bTable"><table><tbody>${skeletonRows(6)}</tbody></table></div>
        <div class="pager"></div>`;
      root.querySelector('#bMetric').addEventListener('change', (e) => { state.metric = e.target.value; renderChart(); });
      root.addEventListener('click', (e) => {
        if (e.target.closest('[data-action=csv]') && profile?.rows.length) {
          downloadCsv(csvName(id, 'billing'), profile.cols.map(colLabel), profile.rows.map((r) => profile.cols.map((c, i) => r.c[i] ?? '')));
        }
        if (e.target.closest('[data-action=retry]')) load().catch(() => {});
      });
    },
    load,
    destroy() { chart?.destroy(); },
  };
}

// ------------------------------------------------------------------ events
const EVENT_CODE = /^0\.0\.96\.11\./;

export function createEventsTab({ id }) {
  const state = { days: -1, cat: '', page: 1 };
  let root;
  let events = [];
  const run = requestRunner();

  function visible() {
    return state.cat ? events.filter((e) => e.cat === state.cat) : events;
  }

  function render() {
    const counts = Object.fromEntries(EVENT_CATEGORIES.map(([, cat]) => [cat, 0]));
    for (const e of events) counts[e.cat]++;
    root.querySelector('#eCats').innerHTML = [`<button class="chip${state.cat ? '' : ' active'}" type="button" data-cat="">All <b>${events.length}</b></button>`,
      ...EVENT_CATEGORIES.filter(([, cat]) => counts[cat] || state.cat === cat).map(([, cat, label]) => `<button class="chip cat-${cat}${state.cat === cat ? ' active' : ''}" type="button" data-cat="${cat}"><span class="dot"></span>${esc(label)} <b>${counts[cat]}</b></button>`)].join('');
    root.querySelectorAll('[data-days]').forEach((b) => b.classList.toggle('active', Number(b.dataset.days) === state.days));
    const rows = visible();
    const body = root.querySelector('tbody');
    if (!rows.length) {
      body.innerHTML = emptyRow(5, events.length ? 'No events in this category' : 'No events in this range', 'Event logs are read every 30 minutes; only new events are sent.');
    } else {
      body.innerHTML = rows.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE).map((e) => {
        const [, name, type] = /^(.*?)(?: - (Occ|Res))?$/.exec(e.e || '') || [];
        return `<tr class="event cat-${e.cat}">
          <td class="full">${esc(e.t || '—')}</td>
          <td data-l="Category"><span class="event-name"><strong>${esc(e.label)}</strong></span></td>
          <td class="wrap" data-l="Event">${esc(name || e.e || '—')} ${type ? `<span class="ev-type ${type.toLowerCase()}">${type === 'Occ' ? 'Occurred' : 'Restored'}</span>` : ''}</td>
          <td class="num" data-l="Code">${esc(e.code ?? '—')}</td>
          <td class="wrap p2" data-l="Snapshot">${esc(e.details || '—')}</td></tr>`;
      }).join('');
    }
    root.querySelector('.pager').innerHTML = pager(state.page, PAGE_SIZE, rows.length, 'events');
  }

  async function load(signal) {
    const body = root.querySelector('tbody');
    try {
      await run(signal, async (s) => {
        const list = (await api(devicePath(id, '/profiles'), { signal: s })).filter((p) => isEventProfile(p.obis));
        const from = state.days > 0 ? meterTimeText(serverNow() - state.days * 86400000) : '';
        const profiles = await Promise.all(list.map((p) => api(devicePath(id, `/profiles/${p.obis}${query({ from, limit: 5000 })}`), { signal: s })));
        events = [];
        for (const p of profiles) {
          const [, cat, label] = EVENT_CATEGORIES.find(([obis]) => obis === p.obis) || [p.obis, 'other', p.name || p.obis];
          const codeIndex = p.cols.findIndex((c) => EVENT_CODE.test(c.obis));
          const extra = p.cols.map((c, i) => ({ c, i })).filter(({ c, i }) => i !== codeIndex && c.obis !== O.clock);
          for (const r of p.rows) {
            events.push({
              t: r.t, e: r.e, cat, label,
              code: codeIndex >= 0 ? r.c[codeIndex] : null,
              details: extra.filter(({ i }) => r.c[i] !== null && r.c[i] !== undefined).map(({ c, i }) => `${c.name || c.obis} ${withUnit(cellText(r.c[i]), c.unit)}`).join(', '),
              cells: r.c, cols: p.cols,
            });
          }
        }
        events.sort((a, b) => (b.t || '').localeCompare(a.t || ''));
        state.page = 1;
        render();
      });
    } catch (error) {
      if (error.name !== 'AbortError') body.innerHTML = `<tr><td colspan="5">${errorBox(error)}</td></tr>`;
      throw error;
    }
  }

  return {
    mount(element) {
      root = element;
      root.innerHTML = `<div class="toolbar">
          <label class="field">Range ${segmented('days', [[7, '7 days'], [31, '31 days'], [365, '1 year'], [-1, 'All']], state.days)}</label>
          <div class="chips" id="eCats" role="group" aria-label="Event category"></div>
          <span class="spacer"></span>
          <button class="btn small" type="button" data-action="csv">${icon('download')}CSV</button>
        </div>
        <div class="tscroll"><table class="cards"><thead><tr><th>Time (meter)</th><th>Category</th><th>Event</th><th class="num">Code</th><th class="p2">Snapshot at event</th></tr></thead>
          <tbody>${skeletonRows(5)}</tbody></table></div>
        <div class="pager"></div>`;
      root.addEventListener('click', (e) => {
        const c = e.target.closest('[data-cat]');
        if (c) {
          state.cat = c.dataset.cat;
          state.page = 1;
          return render();
        }
        const d = e.target.closest('[data-days]');
        if (d) {
          state.days = Number(d.dataset.days);
          return load().catch(() => {});
        }
        const page = e.target.closest('[data-page]');
        if (page && !page.disabled) {
          state.page = Number(page.dataset.page);
          return render();
        }
        if (e.target.closest('[data-action=csv]') && events.length) {
          downloadCsv(csvName(id, 'events'), ['time', 'category', 'event', 'code', 'snapshot'], visible().map((v) => [v.t, v.label, v.e, v.code, v.details]));
        }
        if (e.target.closest('[data-action=retry]')) load().catch(() => {});
      });
    },
    load,
  };
}

// ------------------------------------------------------------- read cycles
export function createReadingsTab({ id }) {
  const state = { hours: 168, page: 1 };
  let root;
  let rows = [];
  const run = requestRunner();

  function render() {
    root.querySelectorAll('[data-hours]').forEach((b) => b.classList.toggle('active', Number(b.dataset.hours) === state.hours));
    const failed = rows.filter((r) => r.ret !== 0).length;
    root.querySelector('.info').textContent = rows.length ? `${rows.length} cycles · ${failed} failed${rows.length >= 2000 ? ' (newest 2000)' : ''}` : '';
    const body = root.querySelector('tbody');
    body.innerHTML = rows.length
      ? rows.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE).map((r) => `<tr class="${r.ret !== 0 ? 'failed' : ''}">
        <td class="full">${esc(dateTime(r.readAt))}</td>
        <td data-l="Received">${esc(dateTime(r.receivedAt))}</td>
        <td class="num" data-l="Delay">${esc(durationText((r.receivedAt - r.readAt) / 1000))}</td>
        <td class="num" data-l="Values">${int(r.valueCount)}</td>
        <td data-l="Result">${retBadge(r.ret)}</td>
        <td class="p2" data-l="FW"><span class="mono">${esc(r.fw || '—')}</span></td>
        <td class="p2" data-l="Signed">${signedBadge(r.verified)}</td></tr>`).join('')
      : emptyRow(7, 'No read cycles in this range', 'Readings are sent every 15 minutes by default.');
    root.querySelector('.pager').innerHTML = pager(state.page, PAGE_SIZE, rows.length, 'cycles');
  }

  async function load(signal) {
    const body = root.querySelector('tbody');
    try {
      await run(signal, async (s) => {
        rows = await api(devicePath(id, `/readings${query({ from: serverNow() - state.hours * 3600000, limit: 2000 })}`), { signal: s });
        state.page = 1;
        render();
      });
    } catch (error) {
      if (error.name !== 'AbortError') body.innerHTML = `<tr><td colspan="7">${errorBox(error)}</td></tr>`;
      throw error;
    }
  }

  return {
    mount(element) {
      root = element;
      root.innerHTML = `<div class="toolbar">
          <label class="field">Range ${segmented('hours', [[24, '24 h'], [168, '7 days'], [720, '30 days']], state.hours)}</label>
          <span class="info"></span><span class="spacer"></span>
          <button class="btn small" type="button" data-action="csv">${icon('download')}CSV</button>
        </div>
        <div class="tscroll"><table class="cards"><thead><tr><th>Read at</th><th>Received</th><th class="num">Delay</th><th class="num">Values</th><th>Result</th><th class="p2">FW</th><th class="p2">Signed</th></tr></thead>
          <tbody>${skeletonRows(7)}</tbody></table></div>
        <div class="pager"></div>`;
      root.addEventListener('click', (e) => {
        const h = e.target.closest('[data-hours]');
        if (h) {
          state.hours = Number(h.dataset.hours);
          return load().catch(() => {});
        }
        const page = e.target.closest('[data-page]');
        if (page && !page.disabled) {
          state.page = Number(page.dataset.page);
          return render();
        }
        if (e.target.closest('[data-action=csv]') && rows.length) {
          downloadCsv(csvName(id, 'read-cycles'), ['read_at', 'received_at', 'values', 'result', 'fw', 'signed'],
            rows.map((r) => [dateTime(r.readAt), dateTime(r.receivedAt), r.valueCount, r.ret, r.fw || '', r.verified ? 1 : 0]));
        }
        if (e.target.closest('[data-action=retry]')) load().catch(() => {});
      });
    },
    load,
  };
}

// --------------------------------------------------------------------- log
export function createLogTab({ id }) {
  let root;
  let text = '';
  const run = requestRunner();

  async function load(signal) {
    const pre = root.querySelector('pre');
    const select = root.querySelector('select');
    try {
      await run(signal, async (s) => {
        const dates = await api(devicePath(id, '/log-dates'), { signal: s });
        const keep = select.value;
        select.innerHTML = dates.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
        if (dates.includes(keep)) select.value = keep;
        if (!dates.length) {
          text = '';
          pre.textContent = 'No log uploaded yet.';
          root.querySelector('.info').textContent = '';
          return;
        }
        const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
        const res = await api(devicePath(id, `/logs?date=${select.value}&tail=262144`), { signal: s, text: true });
        text = res.text;
        pre.textContent = text;
        const size = Number(res.headers.get('X-Log-Size') || 0);
        root.querySelector('.info').textContent = `${bytesText(size)}${res.headers.get('X-Log-Truncated') === '1' ? ' · showing the last 256 KB' : ''}`;
        if (atBottom || !keep) pre.scrollTop = pre.scrollHeight;
      });
    } catch (error) {
      if (error.name !== 'AbortError') pre.textContent = error.message;
      throw error;
    }
  }

  return {
    mount(element) {
      root = element;
      root.innerHTML = `<div class="toolbar">
          <label class="field">Day<select aria-label="Day"></select></label>
          <button class="btn small" type="button" data-action="reload">${icon('refresh')}Reload</button>
          <span class="info"></span><span class="spacer"></span>
          <button class="btn small" type="button" data-action="save">${icon('download')}Save</button>
        </div>
        <pre class="log">Loading…</pre>`;
      root.querySelector('select').addEventListener('change', () => load().catch(() => {}));
      root.addEventListener('click', (e) => {
        if (e.target.closest('[data-action=reload]')) load().catch(() => {});
        if (e.target.closest('[data-action=save]') && text) {
          const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
          const a = document.createElement('a');
          a.href = url;
          a.download = `${id}-${root.querySelector('select').value}.log`;
          document.body.append(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
      });
    },
    load,
  };
}

