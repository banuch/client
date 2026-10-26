'use strict';
// AMR Data page. Plain DOM, no framework. All device data is inserted with
// textContent, never as HTML.

const ONLINE_MS = 35 * 60 * 1000;    // two 15-minute read cycles
const OFFLINE_MS = 90 * 60 * 1000;
const REFRESH_MS = 30 * 1000;
// Profiles wider than this (billing, instantaneous) are shown one row per
// column, newest PROFILE_WIDE_ROWS entries side by side.
const PROFILE_WIDE_COLS = 16;
const PROFILE_WIDE_ROWS = 12;

const $ = (id) => document.getElementById(id);
const state = { devices: [], selected: null, tab: 'latest', latest: null };

async function api(path, asText = false) {
  const res = await fetch(path, { headers: { Accept: asText ? 'text/plain' : 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return asText ? { text: await res.text(), headers: res.headers } : res.json();
}

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString() : '-');

function ago(ms) {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function status(lastSeen) {
  const age = Date.now() - lastSeen;
  return age <= ONLINE_MS ? 'online' : age <= OFFLINE_MS ? 'delayed' : 'offline';
}

function signedBadge(verified) {
  return el('span', { class: `badge ${verified ? 'ok' : 'bad'}`, text: verified ? 'signed' : 'unsigned' });
}

function formatNum(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(3);
}

// ── Device list ─────────────────────────────────────────────────────────────
function renderDevices() {
  const q = $('search').value.trim().toLowerCase();
  const list = $('device-list');
  list.replaceChildren();
  const shown = state.devices.filter((d) => d.id.toLowerCase().includes(q));
  $('no-devices').hidden = state.devices.length !== 0;
  for (const d of shown) {
    const st = status(d.lastSeen);
    const li = el('li', { class: d.id === state.selected ? 'active' : '', onclick: () => select(d.id) },
      el('div', {}, el('span', { class: `dot ${st}`, title: st }), el('span', { class: 'id', text: d.id }),
        signedBadge(d.verified)),
      el('div', { class: 'sub', text: `seen ${ago(d.lastSeen)} · fw ${d.fw || '?'} · ` +
        (d.lastReadAt ? `${d.lastValueCount} values ${ago(d.lastReadAt)}` : 'no reading') }));
    list.append(li);
  }
}

async function loadDevices() {
  try {
    state.devices = await api('/api/devices');
    $('updated').textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    $('updated').textContent = `refresh failed (${e.message})`;
  }
  renderDevices();
}

// ── Detail ──────────────────────────────────────────────────────────────────
function select(id) {
  state.selected = id;
  state.latest = null;
  $('empty').hidden = true;
  $('detail').hidden = false;
  $('d-title').textContent = id;
  renderDevices();
  $('obis-select').replaceChildren();
  $('profile-select').replaceChildren();
  showTab(state.tab);
}

function showTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const t of ['latest', 'history', 'profiles', 'readings', 'log']) $(`tab-${t}`).hidden = t !== tab;
  refreshTab();
}

function refreshTab() {
  if (!state.selected) return;
  const d = state.devices.find((x) => x.id === state.selected);
  $('d-meta').textContent = d ? `first seen ${fmtTime(d.firstSeen)} · last IP ${d.lastIp || '-'}` : '';
  const run = { latest: loadLatest, history: loadHistory, profiles: loadProfiles, readings: loadReadings, log: loadLog }[state.tab];
  run().catch((e) => console.error(e));
}

async function loadLatest() {
  const r = await api(`/api/devices/${encodeURIComponent(state.selected)}/latest`);
  state.latest = r;
  const meta = $('latest-meta');
  meta.replaceChildren();
  if (!r) {
    meta.textContent = 'No reading yet (only logs).';
    $('latest-body').replaceChildren();
    return;
  }
  meta.append(`Read ${fmtTime(r.readAt)} (${ago(r.readAt)}) · result ${r.ret === 0 ? 'OK' : `error ${r.ret}`} · ` +
    `${r.valueCount} values · fw ${r.fw || '?'} `, signedBadge(r.verified));
  renderLatest();
  fillObisSelect(r.values);
}

function renderLatest() {
  const r = state.latest;
  const q = $('value-filter').value.trim().toLowerCase();
  const body = $('latest-body');
  body.replaceChildren();
  if (!r) return;
  for (const v of r.values) {
    if (q && !v.obis.includes(q) && !v.name.toLowerCase().includes(q)) continue;
    body.append(el('tr', {},
      el('td', { class: 'mono', text: v.obis }),
      el('td', { text: v.name }),
      el('td', { class: 'num', text: v.num !== null ? formatNum(v.num) : v.text }),
      el('td', { text: v.unit })));
  }
}

function fillObisSelect(values) {
  const sel = $('obis-select');
  const keep = sel.value;
  const numeric = values.filter((v) => v.num !== null);
  if (sel.options.length === numeric.length) return;
  sel.replaceChildren(...numeric.map((v) => el('option', { value: v.obis, text: `${v.name || v.obis} (${v.obis})` })));
  if (keep) sel.value = keep;
}

async function loadHistory() {
  if (!$('obis-select').options.length) {
    const r = await api(`/api/devices/${encodeURIComponent(state.selected)}/latest`);
    if (r) fillObisSelect(r.values);
  }
  const obis = $('obis-select').value;
  const body = $('history-body');
  body.replaceChildren();
  if (!obis) return drawChart([]);
  const from = Date.now() - Number($('range-select').value) * 86400 * 1000;
  const rows = await api(`/api/devices/${encodeURIComponent(state.selected)}/readings` +
    `?obis=${encodeURIComponent(obis)}&from=${from}&limit=5000`);
  for (const r of rows) {
    body.append(el('tr', {}, el('td', { text: fmtTime(r.readAt) }),
      el('td', { class: 'num', text: r.num !== null ? formatNum(r.num) : r.text }), el('td', { text: r.unit })));
  }
  drawChart(rows.filter((r) => r.num !== null).reverse());
}

function drawChart(rows) {
  const svg = $('chart');
  const NS = 'http://www.w3.org/2000/svg';
  const w = svg.clientWidth || 600;
  const h = svg.clientHeight || 220;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.replaceChildren();
  const pad = { l: 60, r: 10, t: 10, b: 24 };
  const text = (x, y, s, anchor = 'start') => {
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', x); t.setAttribute('y', y); t.setAttribute('text-anchor', anchor);
    t.textContent = s;
    svg.append(t);
  };
  if (rows.length === 0) {
    text(w / 2, h / 2, 'No numeric data in this range', 'middle');
    return;
  }
  const xs = rows.map((r) => r.readAt);
  const ys = rows.map((r) => r.num);
  let [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  let [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  if (x0 === x1) { x0 -= 60000; x1 += 60000; }
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const sx = (x) => pad.l + ((x - x0) / (x1 - x0)) * (w - pad.l - pad.r);
  const sy = (y) => h - pad.b - ((y - y0) / (y1 - y0)) * (h - pad.t - pad.b);
  const axis = document.createElementNS(NS, 'path');
  axis.setAttribute('class', 'axis');
  axis.setAttribute('d', `M${pad.l},${pad.t} V${h - pad.b} H${w - pad.r}`);
  svg.append(axis);
  const line = document.createElementNS(NS, 'polyline');
  line.setAttribute('class', 'line');
  line.setAttribute('points', rows.map((r) => `${sx(r.readAt).toFixed(1)},${sy(r.num).toFixed(1)}`).join(' '));
  svg.append(line);
  text(pad.l - 6, pad.t + 10, formatNum(y1), 'end');
  text(pad.l - 6, h - pad.b, formatNum(y0), 'end');
  text(pad.l, h - 6, new Date(x0).toLocaleString());
  text(w - pad.r, h - 6, new Date(x1).toLocaleString(), 'end');
}

// ── Profiles ────────────────────────────────────────────────────────────────
// Row times are the meter's local time as text, so the range is built from
// the browser's local time (the page and the meters are in the same zone).
function localText(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function cellText(v) {
  if (v === null || v === undefined) return '-';
  return typeof v === 'number' ? formatNum(v) : v;
}

function colLabel(c) {
  return c.unit ? `${c.name || c.obis} (${c.unit})` : (c.name || c.obis);
}

async function loadProfiles() {
  const id = encodeURIComponent(state.selected);
  const list = await api(`/api/devices/${id}/profiles`);
  const sel = $('profile-select');
  const keep = sel.value;
  sel.replaceChildren(...list.map((p) => el('option', { value: p.obis, text: `${p.name || p.obis} (${p.rowCount})` })));
  if (list.some((p) => p.obis === keep)) sel.value = keep;
  const head = $('profile-head');
  const body = $('profile-body');
  if (!list.length) {
    head.replaceChildren();
    body.replaceChildren();
    $('profile-info').textContent = 'No profile data yet (needs firmware 2.0.2).';
    return;
  }
  const info = list.find((p) => p.obis === sel.value);
  const days = Number($('profile-range').value);
  // Profiles without timed rows (name plate) ignore the range.
  const from = days && info.lastT ? `&from=${encodeURIComponent(localText(Date.now() - days * 86400 * 1000))}` : '';
  const p = await api(`/api/devices/${id}/profiles/${encodeURIComponent(sel.value)}?limit=5000${from}`);
  const hasEvents = p.rows.some((r) => r.e);
  const wide = p.cols.length > PROFILE_WIDE_COLS;
  if (wide) {
    // One line per column, newest entries side by side.
    const rows = p.rows.slice(0, PROFILE_WIDE_ROWS);
    head.replaceChildren(el('tr', {}, el('th', { text: 'Column' }),
      ...rows.map((r) => el('th', { class: 'num', text: r.t || fmtTime(r.receivedAt) }))));
    body.replaceChildren(...p.cols.map((c, i) => el('tr', {},
      el('td', { text: colLabel(c), title: c.obis }),
      ...rows.map((r) => el('td', { class: 'num', text: cellText(r.c[i]) })))));
    $('profile-info').textContent = `${p.rows.length} entries in range` +
      (p.rows.length > rows.length ? `, showing the newest ${rows.length}` : '');
    return;
  }
  head.replaceChildren(el('tr', {},
    ...p.cols.map((c) => el('th', { text: colLabel(c), title: c.obis })),
    hasEvents ? el('th', { text: 'Event' }) : null));
  body.replaceChildren(...p.rows.map((r) => el('tr', {},
    ...p.cols.map((c, i) => el('td', { class: typeof r.c[i] === 'number' ? 'num' : '', text: cellText(r.c[i]) })),
    hasEvents ? el('td', { text: r.e || '' }) : null)));
  $('profile-info').textContent = `${p.rows.length} rows` + (p.rows.length >= 5000 ? ' (newest 5000)' : '');
}

async function loadReadings() {
  const rows = await api(`/api/devices/${encodeURIComponent(state.selected)}/readings?limit=500`);
  const body = $('readings-body');
  body.replaceChildren();
  for (const r of rows) {
    body.append(el('tr', {},
      el('td', { text: fmtTime(r.readAt) }), el('td', { text: fmtTime(r.receivedAt) }),
      el('td', { class: 'num', text: String(r.valueCount) }),
      el('td', { text: r.ret === 0 ? 'OK' : `error ${r.ret}` }), el('td', { text: r.fw || '-' }),
      el('td', {}, signedBadge(r.verified))));
  }
}

async function loadLog() {
  const id = encodeURIComponent(state.selected);
  const sel = $('log-date');
  const dates = await api(`/api/devices/${id}/log-dates`);
  const keep = sel.value;
  sel.replaceChildren(...dates.map((d) => el('option', { value: d, text: d })));
  if (dates.includes(keep)) sel.value = keep;
  const pre = $('log-text');
  if (!dates.length) {
    pre.textContent = 'No log uploaded yet.';
    $('log-info').textContent = '';
    return;
  }
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
  const { text, headers } = await api(`/api/devices/${id}/logs?date=${sel.value}&tail=262144`, true);
  pre.textContent = text;
  const size = Number(headers.get('X-Log-Size') || 0);
  $('log-info').textContent = (size < 1024 ? `${size} B` : `${(size / 1024).toFixed(0)} KB`) +
    (headers.get('X-Log-Truncated') === '1' ? ' (showing the last 256 KB)' : '');
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

// ── Wiring ──────────────────────────────────────────────────────────────────
$('search').addEventListener('input', renderDevices);
$('value-filter').addEventListener('input', renderLatest);
$('obis-select').addEventListener('change', () => loadHistory());
$('range-select').addEventListener('change', () => loadHistory());
$('profile-select').addEventListener('change', () => loadProfiles());
$('profile-range').addEventListener('change', () => loadProfiles());
$('log-date').addEventListener('change', () => loadLog());
$('log-refresh').addEventListener('click', () => loadLog());
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));

async function tick() {
  if (document.hidden) return;
  await loadDevices();
  if (state.selected && state.tab !== 'log') refreshTab();
}
loadDevices();
setInterval(tick, REFRESH_MS);
