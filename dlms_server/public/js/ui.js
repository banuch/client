// Markup helpers. Every value inserted into markup goes through esc(); device
// data never reaches innerHTML unescaped. The CSP blocks inline style
// attributes, so per-element sizes are applied with applyGrow() after render.
import { ago, dateTime, shortTime } from './format.js';

export const byId = (id) => document.getElementById(id);

export function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[c]);
}

export function icon(name) {
  return `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

export const STATUS = {
  online: { label: 'Online', icon: 'ok' },
  delayed: { label: 'Delayed', icon: 'clock' },
  offline: { label: 'Offline', icon: 'x' },
};

export function statusBadge(status) {
  const info = STATUS[status] || { label: status, icon: 'minus' };
  return `<span class="st ${esc(status)}">${icon(info.icon)}${esc(info.label)}</span>`;
}

// Result of a meter read cycle (ret 0 = OK, else a DLMS error code).
export function retBadge(ret) {
  if (ret === null || ret === undefined) return '<span class="st off">No reading</span>';
  return ret === 0 ? `<span class="st ok">${icon('ok')}OK</span>` : `<span class="st bad">${icon('warn')}Error ${esc(ret)}</span>`;
}

export function signedBadge(verified) {
  return verified ? `<span class="pill yes">signed</span>` : `<span class="pill neutral">unsigned</span>`;
}

// Issue codes from src/meters.js, coloured by severity.
const ISSUE_TONE = { offline: 'bad', read_failed: 'bad', delayed: 'warn', no_reading: 'warn', read_stale: 'warn', unsigned: 'off' };
export function issueList(issues) {
  return `<span class="issues">${issues.map((i) => `<span class="${ISSUE_TONE[i.code] || 'off'}">${esc(i.text)}</span>`).join('')}</span>`;
}

// A relative age kept current by the page ticker (main.js).
export function agoText(value) {
  return value ? `<span data-ago="${esc(value)}">${esc(ago(value))}</span>` : 'never';
}

// "10:15:02" with "22 s ago" underneath.
export function timeCell(value) {
  if (!value) return '—';
  return `<span title="${esc(dateTime(value))}">${esc(shortTime(value))}</span><span class="when">${agoText(value)}</span>`;
}

export function freshnessTag(status) {
  if (status === 'online') return `<span class="tag live">${icon('ok')}LIVE</span>`;
  if (status === 'delayed') return `<span class="tag delayed">${icon('clock')}DELAYED</span>`;
  return `<span class="tag stale">${icon('x')}STALE</span>`;
}

export function stateBox({ kind = 'empty', title, detail = '', retry = false }) {
  const symbol = { empty: 'search', error: 'warn', good: 'ok', info: 'minus' }[kind] || 'search';
  return `<div class="state ${kind}">${icon(symbol)}<strong>${esc(title)}</strong>${detail ? `<span>${esc(detail)}</span>` : ''}${retry ? '<button class="btn small" type="button" data-action="retry">Try again</button>' : ''}</div>`;
}

export function errorBox(error) {
  return stateBox({ kind: 'error', title: 'Data could not be loaded', detail: error.message, retry: true });
}

export function skeletonRows(columns, rows = 5) {
  const cells = '<td><span class="skeleton"></span></td>'.repeat(columns);
  return Array.from({ length: rows }, () => `<tr>${cells}</tr>`).join('');
}

export function emptyRow(columns, title, detail) {
  return `<tr class="empty"><td colspan="${columns}">${stateBox({ title, detail })}</td></tr>`;
}

// Key/value list. Values are text, or { html } for markup built with esc().
// Items whose value is null or undefined are left out.
export function kvList(items, className = '') {
  const rows = items
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([label, value, alert]) => {
      const content = typeof value === 'object' ? value.html : esc(value);
      return `<div><dt>${esc(label)}</dt><dd${alert ? ' class="alert"' : ''}>${content}</dd></div>`;
    });
  return rows.length ? `<dl class="kv ${className}">${rows.join('')}</dl>` : '';
}

export function pager(page, pageSize, total, noun) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(total, page * pageSize);
  return `<span>${total ? `${start}–${end} of ${total.toLocaleString('en-IN')} ${esc(noun)}` : `0 ${esc(noun)}`}</span><div>
    <button class="btn small" type="button" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>Previous</button>
    <button class="btn small" type="button" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>Next</button></div>`;
}

// Elements rendered with data-grow="n" get flex-grow n (the CSP forbids style="").
export function applyGrow(root) {
  root.querySelectorAll('[data-grow]').forEach((e) => { e.style.flexGrow = e.dataset.grow; });
}

export function toast(message, kind = 'info') {
  const box = document.createElement('div');
  box.className = `toast ${kind}`;
  box.innerHTML = `${icon(kind === 'warn' ? 'warn' : 'ok')}<span>${esc(message)}</span>`;
  byId('toasts').append(box);
  setTimeout(() => box.remove(), 6000);
}

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// Save rows as a CSV file (values quoted where needed).
export function downloadCsv(filename, header, rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Chart.js colours from the CSS tokens, so charts follow the theme.
export function chartTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return {
    text: v('--text'), muted: v('--muted'), grid: v('--line-soft'), accent: v('--accent'),
    phases: [v('--phase-r'), v('--phase-y'), v('--phase-b')], ok: v('--ok'), bad: v('--bad'), warn: v('--warn-line'),
    extra: [v('--violet'), v('--teal'), v('--amber'), v('--sky'), v('--rose')],
    surface: v('--surface'), line: v('--line'),
  };
}

// Chart.js (about 200 KB) is loaded the first time a page needs a chart.
let chartLoad = null;
export function ensureChart() {
  if (window.Chart) return Promise.resolve(window.Chart);
  chartLoad ||= new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = 'vendor/chart.js';
    script.onload = () => {
      const C = window.Chart;
      C.defaults.font.family = getComputedStyle(document.body).fontFamily;
      C.defaults.font.size = 12;
      C.defaults.plugins.tooltip.padding = 10;
      C.defaults.plugins.tooltip.cornerRadius = 8;
      C.defaults.plugins.tooltip.boxPadding = 4;
      C.defaults.plugins.legend.labels.usePointStyle = true;
      C.defaults.plugins.legend.labels.pointStyle = 'rectRounded';
      resolve(C);
    };
    // Pages show "Chart library did not load" when window.Chart stays unset.
    script.onerror = () => { chartLoad = null; resolve(null); };
    document.head.append(script);
  });
  return chartLoad;
}

// Ask before a change that cannot be undone. Resolves true when confirmed.
export function confirmDialog({ title, message, confirmLabel = 'Confirm', tone = 'danger' }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'confirm';
    dialog.setAttribute('aria-labelledby', 'confirmTitle');
    dialog.innerHTML = `<form method="dialog">
      <div class="confirm-body"><span class="icon-tile ${tone === 'danger' ? 'c-bad' : 'c-indigo'}">${icon(tone === 'danger' ? 'warn' : 'info')}</span>
        <div><h2 id="confirmTitle">${esc(title)}</h2><p>${esc(message)}</p></div></div>
      <div class="confirm-actions"><button class="btn" value="cancel" autofocus>Cancel</button>
        <button class="btn ${tone === 'danger' ? 'danger' : 'primary'}" value="ok">${esc(confirmLabel)}</button></div></form>`;
    document.body.append(dialog);
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(ok);
    };
    dialog.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      finish(e.submitter?.value === 'ok');
    });
    dialog.addEventListener('cancel', (e) => {   // Escape
      e.preventDefault();
      finish(false);
    });
    dialog.addEventListener('close', () => finish(false));
    dialog.showModal();
  });
}

// Breadcrumb from [label, href] pairs; the last one is the current page.
export function crumbs(...items) {
  return items.map(([label, href], i) => (i < items.length - 1 && href
    ? `<a href="${href}">${esc(label)}</a><span class="sep" aria-hidden="true">${icon('chevron')}</span>`
    : `<span aria-current="page">${esc(label)}</span>`)).join('');
}
