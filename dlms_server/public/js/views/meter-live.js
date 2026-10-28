// Meter tabs built from the latest reading: instantaneous values, energy and
// demand, meter information, communication health, and the raw value list.
// Each renderer returns markup, or {html, after(pane)} when it needs to run
// code once the markup is on the page (charts).
import { api, devicePath } from '../api.js';
import { num, int, meterNum, withUnit, dateTime, dateOnly, shortTime, present, unbalance, bytesText, durationText, zoneLabel } from '../format.js';
import { esc, freshnessTag, agoText, kvList, stateBox, signedBadge, retBadge, chartTheme, debounce } from '../ui.js';
import { O, PROFILE, valueMap, numOf, unitOf, textOf, tozKwh, tozKvah } from '../obis.js';

const PHASES = [['R', 'r', 'vR', 'iR', 'pfR', 'kwR'], ['Y', 'y', 'vY', 'iY', 'pfY', 'kwY'], ['B', 'b', 'vB', 'iB', 'pfB', 'kwB']];

function capturedLine(meter, latest) {
  return `<div class="captured">${freshnessTag(meter.status)}
    <span>Read ${esc(dateTime(latest.readAt))} ${esc(zoneLabel())} · ${agoText(latest.readAt)}</span>
    <span>· received ${esc(shortTime(latest.receivedAt))}</span>
    ${latest.ret !== 0 ? `<span>· ${retBadge(latest.ret)}</span>` : ''}</div>`;
}

// One value tile; left out when the meter did not send the value.
function param(label, map, obis, { digits = 3, unit, hint = '', hintClass = '' } = {}) {
  const v = map.get(obis);
  if (!v) return '';
  const text = v.num !== null ? meterNum(v.num, digits) : v.text;
  const u = v.num !== null ? (v.unit || unit || '') : '';
  return `<dl class="param"><dt>${esc(label)}</dt><dd${v.num === null ? ' class="text"' : ''} title="${esc(obis)}">${esc(text)}${u ? `<small>${esc(u)}</small>` : ''}</dd>${hint ? `<span class="hint ${hintClass}">${esc(hint)}</span>` : ''}</dl>`;
}

function computedParam(label, text, unit, hint, hintClass = '') {
  return `<dl class="param"><dt>${esc(label)}</dt><dd>${esc(text)}<small>${esc(unit)}</small></dd><span class="hint ${hintClass}">${esc(hint)}</span></dl>`;
}

const staleClass = (meter) => (meter.status === 'offline' ? 'stale-values' : '');

function noReading() {
  return stateBox({ kind: 'info', title: 'No meter reading yet', detail: 'This device has only sent logs so far.' });
}

export function renderInstant({ meter, latest }) {
  if (!latest) return noReading();
  const m = valueMap(latest.values);
  const pv = (label, obis, digits, unit) => {
    const n = numOf(m, obis);
    return n === null ? '' : `<div class="pv"><dt>${label}</dt><dd>${esc(meterNum(n, digits))}<small>${esc(unitOf(m, obis, unit))}</small></dd></div>`;
  };
  let phases = PHASES.map(([name, cls, v, i, pf, kw]) => {
    const cells = pv('Voltage', O[v], 1, 'V') + pv('Current', O[i], 2, 'A') + pv('Power factor', O[pf], 3, '') + pv('Active power', O[kw], 3, 'kW');
    return cells ? `<div class="phase ${cls}"><h4>${name} PHASE</h4><dl>${cells}</dl></div>` : '';
  }).join('');
  if (!phases) {
    const cells = pv('Voltage', O.v, 1, 'V') + pv('Current', O.i, 2, 'A') + pv('Neutral current', O.iN, 2, 'A');
    if (cells) phases = `<div class="phase single"><h4>SINGLE PHASE</h4><dl>${cells}</dl></div>`;
  }

  const vu = unbalance([numOf(m, O.vR), numOf(m, O.vY), numOf(m, O.vB)]);
  const iu = unbalance([numOf(m, O.iR), numOf(m, O.iY), numOf(m, O.iB)]);
  const params = [
    param('Frequency', m, O.freq, { digits: 2 }),
    param('Active power', m, O.kw),
    param('Active power export', m, O.kwExport),
    param('Reactive power', m, O.kvar),
    param('Apparent power', m, O.kva),
    param('System power factor', m, O.pf),
    phases.includes('SINGLE') ? '' : param('Neutral current', m, O.iN, { digits: 2 }),
    vu === null ? '' : computedParam('Voltage unbalance', num(vu, 1), '%', vu > 3 ? 'Above 3 % · from R/Y/B' : 'From R/Y/B', vu > 3 ? 'warn' : ''),
    iu === null ? '' : computedParam('Current unbalance', num(iu, 1), '%', iu > 20 ? 'Above 20 % · from R/Y/B' : 'From R/Y/B', iu > 20 ? 'warn' : ''),
  ].join('');

  if (!phases && !params) {
    return capturedLine(meter, latest) + stateBox({ kind: 'info', title: 'No instantaneous values', detail: 'The latest reading carried no voltage, current or power values. The All values tab lists what it did carry.' });
  }
  return `${capturedLine(meter, latest)}
    <div class="${staleClass(meter)}">
      ${phases ? `<div class="phases">${phases}</div>` : ''}
      ${params ? `<div class="params">${params}</div>` : ''}
    </div>`;
}

// Latest row of a profile as {obis -> value} and {obis -> capture time}, or
// null if the device never sent the profile. Capture time columns are named
// "<name> time" by the firmware (profiles.ino pg_columnName).
async function latestProfileRow(id, obis, signal) {
  try {
    const p = await api(devicePath(id, `/profiles/${obis}?limit=1`), { signal });
    const row = p.rows[0];
    if (!row) return null;
    const values = new Map();
    const times = new Map();
    p.cols.forEach((c, i) => {
      if (/ time$/.test(c.name)) times.set(c.obis, row.c[i]);
      else if (!values.has(c.obis)) values.set(c.obis, { num: typeof row.c[i] === 'number' ? row.c[i] : null, text: typeof row.c[i] === 'string' ? row.c[i] : null, unit: c.unit });
    });
    return { t: row.t, values, times };
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

export async function renderEnergy({ meter, latest, id, signal }) {
  if (!latest) return noReading();
  const m = valueMap(latest.values);
  const billing = await latestProfileRow(id, PROFILE.billing, signal);
  const registers = [
    param('Active import', m, O.kwh, { digits: 2 }),
    param('Active export', m, O.kwhExport, { digits: 2 }),
    param('Apparent import', m, O.kvah, { digits: 2 }),
    param('Apparent export', m, O.kvahExport, { digits: 2 }),
    param('Reactive lag', m, O.kvarhLag, { digits: 2 }),
    param('Reactive lead', m, O.kvarhLead, { digits: 2 }),
  ].join('');

  // Maximum demand: value from the reading, time of occurrence from the
  // current billing row when the meter has one.
  const demand = [['Active MD (kW)', O.mdKw], ['Apparent MD (kVA)', O.mdKva], ['Active MD export', O.mdKwExport], ['Apparent MD export', O.mdKvaExport],
    ['Cumulative MD (kW)', O.cumMdKw], ['Cumulative MD (kVA)', O.cumMdKva]]
    .map(([label, obis]) => {
      const v = m.get(obis) || billing?.values.get(obis);
      if (!v || v.num === null) return '';
      const when = billing?.times.get(obis);
      return `<tr><td class="full"><b>${esc(label)}</b><span class="sub mono">${esc(obis)}</span></td>
        <td class="num val" data-l="Value">${esc(withUnit(meterNum(v.num, 3), v.unit))}</td>
        <td data-l="Occurred">${esc(when || '—')}</td></tr>`;
    }).join('');

  // Time-of-day zones: from the reading, else from the current billing row.
  const tou = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => {
    const kwh = m.get(tozKwh(n)) || billing?.values.get(tozKwh(n));
    const kvah = m.get(tozKvah(n)) || billing?.values.get(tozKvah(n));
    if (![kwh, kvah].some((v) => v && v.num)) return '';
    const cell = (v) => (v && v.num !== null ? withUnit(meterNum(v.num, 2), v.unit) : '—');
    return `<tr><td class="full"><b>TZ${n}</b></td><td class="num val" data-l="Active energy">${esc(cell(kwh))}</td><td class="num val" data-l="Apparent energy">${esc(cell(kvah))}</td></tr>`;
  }).join('');
  const touFromBilling = tou && !m.has(tozKwh(1)) && billing;

  return `<div class="${staleClass(meter)}">
    <h2 class="section">Energy registers</h2>
    ${registers ? `${capturedLine(meter, latest)}<div class="params">${registers}</div>`
      : stateBox({ kind: 'info', title: 'No energy registers', detail: 'The latest reading carried no energy values.' })}

    <h2 class="section">Maximum demand ${billing ? `<small>occurrence times from the billing row ${esc(billing.t || '')}</small>` : ''}</h2>
    <div class="panel">${demand
      ? `<div class="tscroll"><table class="cards"><thead><tr><th>Register</th><th class="num">Value</th><th>Occurred</th></tr></thead><tbody>${demand}</tbody></table></div>`
      : stateBox({ title: 'No maximum demand values', detail: 'They arrive with the reading or the billing profile.' })}</div>

    <h2 class="section">Time-of-day zones ${touFromBilling ? `<small>from the current billing row ${esc(billing.t || '')}; zones without energy are hidden</small>` : '<small>zones without energy are hidden</small>'}</h2>
    <div class="panel">${tou
      ? `<div class="tscroll"><table class="cards"><thead><tr><th>Zone</th><th class="num">Active energy</th><th class="num">Apparent energy</th></tr></thead><tbody>${tou}</tbody></table></div>`
      : stateBox({ title: 'No time-of-day zone data', detail: 'Zone values arrive with the billing profile.' })}</div>
  </div>`;
}

export async function renderInfo({ meter, latest, id, signal }) {
  const m = valueMap(latest?.values);
  // Name plate profile as a fallback for values the read cycle did not carry.
  const plate = await latestProfileRow(id, PROFILE.nameplate, signal);
  const text = (obis) => textOf(m, obis) ?? (plate?.values.get(obis) ? (plate.values.get(obis).text ?? String(plate.values.get(obis).num)) : null);
  const withU = (obis, digits = 2) => {
    const n = numOf(m, obis);
    return n === null ? null : withUnit(meterNum(n, digits), unitOf(m, obis));
  };
  const seconds = (obis) => {
    const n = numOf(m, obis);
    if (n === null) return null;
    const unit = unitOf(m, obis);
    return durationText(unit === 'min' ? n * 60 : unit === 'h' ? n * 3600 : n);
  };

  const nameplate = kvList([
    ['Meter serial', text(O.serial)],
    ['Manufacturer', text(O.manufacturer)],
    ['Device type', text(O.deviceType)],
    ['Meter type', text(O.meterType)],
    ['Meter category', text(O.category)],
    ['Current rating', text(O.currentRating)],
    ['Meter firmware', text(O.meterFw)],
    ['Hardware version', text(O.hwVersion)],
    ['Year of manufacture', text(O.year)],
  ]);
  const config = kvList([
    ['CT ratio', withU(O.ctRatio)],
    ['PT ratio', withU(O.ptRatio)],
    ['Demand integration period', seconds(O.demandPeriod)],
    ['Profile capture period', seconds(O.profilePeriod)],
    ['Daily profile period', seconds(O.dailyPeriod)],
  ]);
  const counters = kvList([
    ['Power failures', withU(O.powerFailures, 0)],
    ['Power-off duration', withU(O.powerOffDuration, 0)],
    ['Power-on duration', withU(O.powerOnDuration, 0)],
    ['Tamper count', withU(O.tamperCount, 0)],
    ['Billing count', withU(O.billingCount, 0)],
    ['Programming count', withU(O.programmingCount, 0)],
    ['Last billing date', text(O.billingDate)],
  ]);
  const device = kvList([
    ['Device ID (IMEI)', meter.id],
    ['Device firmware', meter.fw || '—'],
    ['Signed data', { html: signedBadge(meter.verified) }],
    ['First seen', dateTime(meter.firstSeen)],
    ['Last IP address', meter.lastIp || '—'],
  ]);
  return `<div class="two even">
    <section class="panel"><div class="panel-head"><h3>Name plate</h3>${plate ? '<span class="note">Gaps filled from the name plate profile</span>' : ''}</div>
      ${nameplate || stateBox({ title: 'No name plate values reported yet' })}</section>
    <div class="stack">
      <section class="panel"><div class="panel-head"><h3>Configuration</h3></div>${config || stateBox({ title: 'No configuration values reported' })}</section>
      <section class="panel"><div class="panel-head"><h3>AMR device</h3></div>${device}</section>
    </div>
  </div>
  <section class="panel gap-top"><div class="panel-head"><h3>Meter counters</h3><span class="note">From the latest reading</span></div>${counters || stateBox({ title: 'No counters reported' })}</section>`;
}

let commChart = null;

export async function renderComm({ meter, id, signal }) {
  const s = await api(devicePath(id, '/stats?days=7'), { signal });
  const r = s.readings;
  const rate = r.n ? (1 - r.failed / r.n) * 100 : null;
  const link = kvList([
    ['Status', { html: `${freshnessTag(meter.status)} last message ${agoText(meter.lastSeen)}` }],
    ['Last message', dateTime(meter.lastSeen)],
    ['Last IP address', meter.lastIp || '—'],
    ['Device firmware', meter.fw || '—'],
    ['Last message signed', { html: signedBadge(meter.verified) }],
    ['First seen', dateTime(meter.firstSeen)],
  ], 'single');
  const reads = kvList([
    ['Read cycles', int(r.n)],
    ['Failed cycles', int(r.failed), r.failed > 0],
    ['Success rate', rate === null ? '—' : `${num(rate, 1)} %`, rate !== null && rate < 95],
    ['Average delivery delay', present(r.avgDelayMs) ? durationText(r.avgDelayMs / 1000) : '—'],
    ['Device boots seen', int(r.boots)],
  ], 'single');
  const logs = kvList([
    ['Log uploads', int(s.logs.n)],
    ['Log data', bytesText(s.logs.bytes)],
    ['Log bytes dropped on device', int(s.logs.dropped), s.logs.dropped > 0],
    ['Last log upload', s.lastLog ? { html: `${esc(dateTime(s.lastLog.at))} · ${agoText(s.lastLog.at)}` } : '—'],
    ['Device uptime at last upload', s.lastLog ? durationText(s.lastLog.uptimeS) : '—'],
  ], 'single');

  const html = `<div class="two even">
    <section class="panel"><div class="panel-head"><h3>Link</h3></div>${link}</section>
    <div class="stack">
      <section class="panel"><div class="panel-head"><h3>Meter reads</h3><span class="note">Last ${s.days} days</span></div>${reads}</section>
      <section class="panel"><div class="panel-head"><h3>Serial log uploads</h3><span class="note">Last ${s.days} days</span></div>${logs}</section>
    </div>
  </div>
  <section class="panel gap-top"><div class="panel-head"><h3>Read cycles per day</h3><span class="note">Failed cycles in red; delivery delay = time a reading waited in the device queue</span></div>
    <div class="chart-box short"><canvas role="img" aria-label="Read cycles per day"></canvas></div></section>`;

  return {
    html,
    after(pane) {
      commChart?.destroy();
      commChart = null;
      if (!window.Chart) return;
      const t = chartTheme();
      const labels = s.perDay.map((_, i) => dateOnly(s.from + i * 86400000 + 12 * 3600000).slice(5));
      commChart = new window.Chart(pane.querySelector('canvas'), {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label: 'OK', data: s.perDay.map((d) => d.readings - d.failed), backgroundColor: t.ok, stack: 'r' },
            { label: 'Failed', data: s.perDay.map((d) => d.failed), backgroundColor: t.bad, stack: 'r' },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          scales: {
            x: { stacked: true, ticks: { color: t.muted }, grid: { display: false } },
            y: { stacked: true, beginAtZero: true, ticks: { color: t.muted, precision: 0 }, grid: { color: t.grid } },
          },
          plugins: { legend: { align: 'end', labels: { color: t.text, boxWidth: 10, boxHeight: 10 } } },
        },
      });
    },
  };
}

// Every value of the latest reading, with a filter. Refreshes with the page.
export function createValuesTab({ latest: initial }) {
  let root;
  let latest = initial;
  const render = () => {
    const body = root.querySelector('tbody');
    const info = root.querySelector('.info');
    if (!latest) {
      info.textContent = '';
      body.innerHTML = `<tr><td colspan="4">${noReading()}</td></tr>`;
      return;
    }
    const q = root.querySelector('input').value.trim().toLowerCase();
    const rows = latest.values.filter((v) => !q || v.obis.includes(q) || v.name.toLowerCase().includes(q));
    info.textContent = `${rows.length} of ${latest.valueCount} values · read ${dateTime(latest.readAt)} · fw ${latest.fw || '?'}`;
    body.innerHTML = rows.map((v) => `<tr><td class="mono">${esc(v.obis)}</td><td>${esc(v.name)}</td>
      <td class="num">${esc(v.num !== null ? meterNum(v.num, 4) : v.text)}</td><td>${esc(v.unit)}</td></tr>`).join('')
      || `<tr><td colspan="4">${stateBox({ title: 'No value matches the filter' })}</td></tr>`;
  };
  return {
    mount(element) {
      root = element;
      root.innerHTML = `<div class="toolbar"><div class="grow"><input type="search" placeholder="Filter by OBIS code or name" aria-label="Filter values"></div><span class="info"></span></div>
        <div class="tscroll tall"><table><thead><tr><th>OBIS</th><th>Name</th><th class="num">Value</th><th>Unit</th></tr></thead><tbody></tbody></table></div>`;
      root.querySelector('input').addEventListener('input', debounce(render, 150));
    },
    setLatest(value) { latest = value; },
    async load() { render(); },
  };
}
