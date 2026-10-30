// Home: status of every device, today's traffic (with yesterday until the
// same time for comparison), the meters that need attention, most urgent
// first, and the devices that sent something most recently.
import { api } from '../api.js';
import { shortTime, dateTime, int, meterName, meterIds, zoneLabel } from '../format.js';
import {
  esc, icon, statusBadge, timeCell, agoText, stateBox, errorBox, skeletonRows, issueList,
  chartTheme, ensureChart, crumbs, toast,
} from '../ui.js';
import { downloadMetersCsv } from './meters.js';

const REFRESH_MS = 30000;
const RECENT = 8;

const KPI_SKELETON = '<div class="kpi"><span class="skeleton short"></span><span class="skeleton title"></span><span class="skeleton"></span></div>';

const LAYOUT = `
  <div class="page-head">
    <div><h1>Fleet overview</h1><p id="homeSub"><span class="skeleton title"></span></p></div>
    <div class="actions" id="homeActions"></div>
  </div>
  <div class="kpis">${KPI_SKELETON.repeat(6)}</div>
  <div class="two stretch gap-top">
    <section class="panel"><div class="panel-head"><h3>${icon('activity')}Activity today</h3><div class="legend" id="chartLegend"></div></div>
      <div class="chart-box home" id="homeChart"><span class="skeleton chart"></span></div></section>
    <section class="panel"><div class="panel-head"><h3>${icon('meter')}Fleet health</h3><span class="note" id="healthNote"></span></div>
      <div id="health"><div class="health-body"><span class="skeleton block"></span></div></div></section>
  </div>
  <div class="two even gap-top">
    <section class="panel"><div class="panel-head"><h3>${icon('warn')}Needs attention</h3><span class="count-badge" id="attentionCount"></span></div>
      <div id="attentionBody"><table><tbody>${skeletonRows(3, 4)}</tbody></table></div></section>
    <section class="panel"><div class="panel-head"><h3>${icon('clock')}Recent activity</h3><span class="note">Latest message per device</span></div>
      <div id="recentBody"><table><tbody>${skeletonRows(2, 4)}</tbody></table></div></section>
  </div>
  <section class="panel gap-top"><div class="panel-head"><h3>${icon('chip')}Status by device firmware</h3></div>
    <div id="firmwareBody" class="tscroll"><table><tbody>${skeletonRows(5, 2)}</tbody></table></div></section>`;

// Change against yesterday until the same time. upIsGood: more is better.
function delta(today, yesterday, upIsGood) {
  if (!yesterday) return today ? '<span class="delta flat">none yesterday</span>' : '';
  const pct = Math.round(((today - yesterday) / yesterday) * 100);
  if (pct === 0) return '<span class="delta flat">±0%</span>';
  const good = pct > 0 === upIsGood;
  return `<span class="delta ${good ? 'good' : 'bad'}">${icon(pct > 0 ? 'up' : 'dn')}${pct > 0 ? '+' : ''}${pct}%</span>`;
}

function kpi({ color, symbol, label, value, valueClass = '', foot = '', href, tone = '' }) {
  const tag = href ? 'a' : 'div';
  return `<${tag} class="kpi ${tone}"${href ? ` href="${href}"` : ''}>
    <div class="kpi-top"><span class="icon-tile ${color}">${icon(symbol)}</span><span class="label">${esc(label)}</span></div>
    <strong class="${valueClass}">${value}</strong><div class="kpi-foot">${foot}</div></${tag}>`;
}

// The legend repeats the numbers, so the ring is never the only carrier of meaning.
function healthRing(counts) {
  const parts = [['online', 'Online'], ['delayed', 'Delayed'], ['offline', 'Offline']];
  const r = 52;
  const length = 2 * Math.PI * r;
  let offset = 0;
  const segments = parts.filter(([key]) => counts[key] > 0).map(([key]) => {
    const share = counts[key] / counts.total;
    const seg = `<circle class="seg ${key}" r="${r}" cx="74" cy="74" stroke-dasharray="${share * length} ${length}" stroke-dashoffset="${-offset}"/>`;
    offset += share * length;
    return seg;
  }).join('');
  const pct = Math.round((counts.online / counts.total) * 100);
  return `<div class="health-body">
      <div class="ring" role="img" aria-label="${esc(parts.map(([key, label]) => `${label} ${counts[key]}`).join(', '))}">
        <svg viewBox="0 0 148 148"><circle class="track" r="${r}" cx="74" cy="74"/>${segments}</svg>
        <div class="ring-center"><strong>${pct}%</strong><small>online</small></div></div>
      <div class="health-legend">${parts.map(([key, label]) => `<a href="#/meters?status=${key}"><span class="dot ${key}"></span>${esc(label)}
        <b>${int(counts[key])}</b><span class="share">${Math.round((counts[key] / counts.total) * 100)}%</span></a>`).join('')}</div>
    </div>`;
}

// What the device's latest message was: a log upload, or a reading (OK or failed).
function recentItem(m) {
  const logLatest = m.lastLogAt && m.lastSeen - m.lastLogAt < 5000;
  const failed = m.lastReadAt && m.lastRet !== 0;
  const [color, symbol, what] = logLatest
    ? ['c-violet', 'file', 'Log upload']
    : failed ? ['c-bad', 'warn', `Meter read failed (code ${m.lastRet})`]
      : m.lastReadAt ? ['c-ok', 'ok', 'Reading received'] : ['c-off', 'minus', 'Message received'];
  return `<li><a href="#/meters/${encodeURIComponent(m.id)}${logLatest ? '/log' : ''}">
    <span class="icon-tile ${color}">${icon(symbol)}</span>
    <span class="what"><strong>${esc(meterName(m))}</strong><span>${esc(what)} · ${esc([...meterIds(m)].join(' · ') || m.id)}</span></span>
    <time datetime="${new Date(m.lastSeen).toISOString()}" title="${esc(dateTime(m.lastSeen))}">${esc(shortTime(m.lastSeen))}<span class="when">${agoText(m.lastSeen)}</span></time></a></li>`;
}

export function createHomeView(route, context) {
  let root;
  let data = null;
  let meters = [];
  let chart = null;
  const { settings } = context;

  function renderHead() {
    const { counts } = data;
    const last = data.lastMessage;
    root.querySelector('#homeSub').innerHTML = `Today since 00:00 ${esc(zoneLabel())}${last
      ? ` · last message ${agoText(last.at)} from <a class="link" href="#/meters/${encodeURIComponent(last.id)}">${esc(last.name || last.id)}</a>` : ''}`;
    root.querySelector('#homeActions').innerHTML = `
      <a class="btn" href="#/meters?status=offline">${icon('x')}<span class="label">Offline</span> <b>${int(counts.offline)}</b></a>
      <a class="btn" href="#/meters?status=failed">${icon('warn')}<span class="label">Read failures</span> <b>${int(counts.readFailed)}</b></a>
      <button class="btn" type="button" data-action="export" data-tip="Download every meter with its status and latest values">${icon('download')}<span class="label">Export CSV</span></button>
      <a class="btn primary" href="#/meters?status=">${icon('meter')}<span class="label">All meters</span></a>`;
  }

  function renderKpis() {
    const { counts, yesterday } = data;
    const share = (n) => `${Math.round((n / counts.total) * 100)}% of fleet`;
    const box = root.querySelector('.kpis');
    // The first cards animate in; later refreshes replace them quietly.
    if (box.querySelector('.kpi strong:not(.skeleton)')) box.classList.add('settled');
    box.innerHTML = [
      kpi({ color: 'c-indigo', symbol: 'meter', label: 'Devices', value: int(counts.total), href: '#/meters?status=',
        foot: '<small>Sent data at least once</small>' }),
      kpi({ color: 'c-ok', symbol: 'ok', label: 'Online', value: int(counts.online), href: '#/meters?status=online',
        foot: `<small>${share(counts.online)} · message within ${settings.onlineAfterMin} min</small>` }),
      kpi({ color: 'c-warn', symbol: 'clock', label: 'Delayed', value: int(counts.delayed), href: '#/meters?status=delayed', tone: counts.delayed ? 'warn' : '',
        foot: `<small>${settings.onlineAfterMin}–${settings.offlineAfterMin} min since message</small>` }),
      kpi({ color: 'c-bad', symbol: 'x', label: 'Offline', value: int(counts.offline), href: '#/meters?status=offline', tone: counts.offline ? 'bad' : '',
        foot: `<small>No message for ${settings.offlineAfterMin}+ min</small>` }),
      kpi({ color: 'c-sky', symbol: 'activity', label: 'Readings today', value: int(data.readingsToday),
        foot: `${delta(data.readingsToday, yesterday?.readings, true)}<small>vs ${int(yesterday?.readings ?? 0)} by now yesterday</small>` }),
      kpi({ color: 'c-rose', symbol: 'warn', label: 'Failed reads today', value: int(data.failedToday), href: '#/meters?status=failed',
        foot: `${delta(data.failedToday, yesterday?.failed, false)}<small>${int(counts.readFailed)} meter${counts.readFailed === 1 ? '' : 's'} failing now</small>` }),
    ].join('');
  }

  // Readings per hour since local midnight: OK and failed stacked, log uploads as a line.
  async function renderChart(reason) {
    const box = root.querySelector('#homeChart');
    const t = chartTheme();
    root.querySelector('#chartLegend').innerHTML = [['OK reads', t.ok], ['Failed reads', t.bad], ['Log uploads', t.extra[0], true]]
      .map(([label, color, line]) => `<span><i class="${line ? 'line' : ''}" data-color="${color}"></i>${label}</span>`).join('');
    root.querySelectorAll('#chartLegend i').forEach((i) => i.style.setProperty('--c', i.dataset.color));
    const elapsed = Math.floor((data.now - data.dayStart) / 3600000);
    const series = (fn) => data.hours.map((h, i) => (i > elapsed ? null : fn(h)));
    const sets = [series((h) => h.readings - h.failed), series((h) => h.failed), series((h) => h.logs)];
    if (chart && reason !== 'theme') {
      sets.forEach((d, i) => { chart.data.datasets[i].data = d; });
      chart.update('none');
      return;
    }
    const Chart = await ensureChart();
    if (!root.isConnected) return;
    chart?.destroy();
    chart = null;
    if (!Chart) {
      box.innerHTML = stateBox({ kind: 'error', title: 'Chart library did not load' });
      return;
    }
    box.innerHTML = '<canvas role="img" aria-label="Meter readings and log uploads per hour today"></canvas>';
    const labels = data.hours.map((_, i) => String(i).padStart(2, '0'));
    chart = new Chart(box.querySelector('canvas'), {
      data: {
        labels,
        datasets: [
          { type: 'bar', label: 'OK reads', data: sets[0], backgroundColor: t.ok, stack: 'r', borderRadius: 4, maxBarThickness: 22, order: 2 },
          { type: 'bar', label: 'Failed reads', data: sets[1], backgroundColor: t.bad, stack: 'r', borderRadius: 4, maxBarThickness: 22, order: 2 },
          { type: 'line', label: 'Log uploads', data: sets[2], borderColor: t.extra[0], backgroundColor: t.extra[0], borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, cubicInterpolationMode: 'monotone', spanGaps: false, order: 1 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
        interaction: { intersect: false, mode: 'index' },
        scales: {
          x: { stacked: true, ticks: { color: t.muted, maxRotation: 0, autoSkipPadding: 8 }, grid: { display: false }, border: { color: t.line } },
          y: { stacked: true, beginAtZero: true, ticks: { color: t.muted, precision: 0, maxTicksLimit: 5 }, grid: { color: t.grid }, border: { display: false } },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => { const h = Number(items[0].label); return `${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00`; },
            },
          },
        },
      },
    });
  }

  function renderHealth() {
    const { counts } = data;
    root.querySelector('#healthNote').textContent = `${int(counts.total)} device${counts.total === 1 ? '' : 's'}`;
    const signingOn = settings.signing !== 'off';
    root.querySelector('#health').innerHTML = healthRing(counts)
      + (signingOn && counts.unsigned ? `<div class="health-note"><a href="#/meters?status=unsigned">${icon('lock')} ${int(counts.unsigned)} device(s) sending unsigned data</a></div>` : '');
  }

  function renderLists() {
    const list = data.attention;
    const badge = root.querySelector('#attentionCount');
    badge.textContent = list.length;
    badge.className = `count-badge${list.length ? ' bad' : ''}`;
    root.querySelector('#attentionBody').innerHTML = list.length
      ? `<div class="tscroll"><table class="cards"><thead><tr><th>Meter</th><th>Status</th><th>Issue</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>
        ${list.map((m) => `<tr class="row-link" data-href="#/meters/${encodeURIComponent(m.id)}">
          <td class="full"><a class="link" href="#/meters/${encodeURIComponent(m.id)}">${esc(meterName(m))}</a><span class="sub">${esc([...meterIds(m), m.manufacturer].filter(Boolean).join(' · '))}</span></td>
          <td data-l="Status">${statusBadge(m.status)}<span class="when">${agoText(m.lastSeen)}</span></td>
          <td class="wrap" data-l="Issue">${issueList(m.issues)}</td>
          <td class="actions-cell"><span class="row-actions"><a class="btn small icon-only ghost" href="#/meters/${encodeURIComponent(m.id)}/log" data-tip="Device log" aria-label="Device log of ${esc(meterName(m))}">${icon('file')}</a>
            <a class="btn small icon-only ghost" href="#/meters/${encodeURIComponent(m.id)}/comm" data-tip="Communication" aria-label="Communication of ${esc(meterName(m))}">${icon('activity')}</a></span></td>
        </tr>`).join('')}</tbody></table></div>`
      : stateBox({ kind: 'good', title: 'All devices are fine', detail: `Every device sent a message within ${settings.onlineAfterMin} min and its last meter read succeeded.` });

    const recent = [...meters].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, RECENT);
    root.querySelector('#recentBody').innerHTML = recent.length
      ? `<ul class="activity">${recent.map(recentItem).join('')}</ul>`
      : stateBox({ title: 'Nothing received yet' });

    const cell = (value, tone) => `<td class="num${value ? ` ${tone}` : ' zero'}">${int(value)}</td>`;
    root.querySelector('#firmwareBody').innerHTML = `<table><thead><tr><th>Firmware</th><th class="num">Online</th><th class="num">Delayed</th><th class="num">Offline</th><th class="num">Total</th></tr></thead><tbody>
      ${data.byFirmware.map((r) => `<tr><td class="mono">${esc(r.fw)}</td>${cell(r.online, '')}${cell(r.delayed, 'warn')}${cell(r.offline, 'bad')}<td class="num total">${int(r.total)}</td></tr>`).join('')}
      </tbody></table>`;
  }

  async function render(reason) {
    context.setAlertCount(data.counts);
    if (data.counts.total === 0) {
      chart?.destroy();
      chart = null;
      root.innerHTML = `<div class="page-head"><div><h1>Fleet overview</h1></div></div><div class="panel">${stateBox({
        kind: 'info',
        title: 'No device has sent data yet',
        detail: 'A device appears here after its first reading or log upload reaches the device port.',
      })}</div>`;
      return;
    }
    if (!root.querySelector('.kpis')) root.innerHTML = LAYOUT;
    renderHead();
    renderKpis();
    renderHealth();
    renderLists();
    await renderChart(reason);
  }

  return {
    mount(element) {
      root = element;
      context.setCrumb(crumbs(['Home']));
      root.innerHTML = LAYOUT;
      root.addEventListener('click', (e) => {
        if (e.target.closest('[data-action=retry]')) context.reload('manual');
        if (e.target.closest('[data-action=export]')) {
          if (meters.length) downloadMetersCsv(meters);
          else toast('No meter data to export yet.', 'warn');
        }
        // Whole rows open their meter; real links inside keep normal behaviour.
        const row = e.target.closest('tr[data-href]');
        if (row && !e.target.closest('a') && !window.getSelection().toString()) location.hash = row.dataset.href;
      });
    },
    async load(signal, reason) {
      const [fleet, list] = await Promise.all([api('/api/fleet', { signal }), api('/api/meters', { signal })]);
      data = fleet;
      meters = list.meters;
      await render(reason);
    },
    refreshMs: () => REFRESH_MS,
    hasData: () => Boolean(data),
    showError(error) {
      chart?.destroy();
      chart = null;
      root.innerHTML = `<div class="panel">${errorBox(error)}</div>`;
    },
    destroy() {
      chart?.destroy();
      chart = null;
    },
  };
}
