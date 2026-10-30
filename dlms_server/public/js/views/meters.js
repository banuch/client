// Meter list with status and the latest values. The fleet is small, so the
// list is loaded whole and searched, filtered, sorted and paged in the browser.
import { api } from '../api.js';
import { num, meterNum, withUnit, average, present, meterName, meterIds } from '../format.js';
import { esc, icon, statusBadge, timeCell, retBadge, signedBadge, pager, skeletonRows, emptyRow, errorBox, debounce, issueList } from '../ui.js';

const REFRESH_MS = 30000;
const PAGE_SIZE = 25;
const COLUMNS = 10;
const STATUS_ORDER = { offline: 0, delayed: 1, online: 2 };
const FILTERS = {
  online: (m) => m.status === 'online',
  delayed: (m) => m.status === 'delayed',
  offline: (m) => m.status === 'offline',
  failed: (m) => m.issues.some((i) => i.code === 'read_failed' || i.code === 'no_reading'),
  unsigned: (m) => m.issues.some((i) => i.code === 'unsigned'),
};
const SORTS = {
  meter: { label: 'Meter', first: 'asc', key: (m) => meterName(m).toLowerCase() },
  status: { label: 'Status', first: 'asc', key: (m) => STATUS_ORDER[m.status] * 10 + (m.issues.length ? 0 : 1) },
  last: { label: 'Last message', first: 'desc', key: (m) => m.lastSeen },
  power: { label: 'Active power', first: 'desc', key: (m) => m.values.kw?.num ?? -Infinity },
  energy: { label: 'Energy import', first: 'desc', key: (m) => m.values.kwh?.num ?? -Infinity },
  fw: { label: 'Firmware', first: 'asc', key: (m) => m.fw || '' },
};

// Filter state survives opening a meter and coming back.
const state = { search: '', status: '', sort: 'status', dir: 'asc', page: 1 };

function applyRoute(route) {
  const search = route.params.get('search');
  const status = route.params.get('status');
  if (search === null && status === null) return false;
  state.search = search || '';
  state.status = FILTERS[status] ? status : '';
  state.page = 1;
  return true;
}

const v = (m, key) => m.values[key];

function voltageText(m) {
  const three = [v(m, 'vR'), v(m, 'vY'), v(m, 'vB')];
  if (three.some(Boolean)) return `${three.map((x) => num(x?.num, 1)).join(' / ')} V`;
  return v(m, 'v') ? withUnit(num(v(m, 'v').num, 1), 'V') : '—';
}

function currentText(m) {
  const avg = average([v(m, 'iR')?.num, v(m, 'iY')?.num, v(m, 'iB')?.num]);
  if (avg !== null) return withUnit(num(avg, 2), 'A');
  return v(m, 'i') ? withUnit(num(v(m, 'i').num, 2), 'A') : '—';
}

const valueText = (x, digits) => (x && present(x.num) ? withUnit(meterNum(x.num, digits), x.unit) : '—');

export function createMetersView(route, context) {
  let root;
  let data = null;
  applyRoute(route);

  function visible() {
    const term = state.search.toLowerCase();
    let rows = data.meters;
    if (term) rows = rows.filter((m) => [m.name, m.id, m.serial, m.manufacturer, m.fw, m.lastIp].some((s) => s && String(s).toLowerCase().includes(term)));
    if (state.status) rows = rows.filter(FILTERS[state.status]);
    const { key } = SORTS[state.sort];
    const dir = state.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => (key(a) < key(b) ? -dir : key(a) > key(b) ? dir : a.id.localeCompare(b.id)));
  }

  function renderChips() {
    const { counts } = data;
    const chip = (value, label, count, symbol, tone) => `<button class="chip ${tone || ''}${state.status === value ? ' active' : ''}" type="button" data-status="${value}" aria-pressed="${state.status === value}">
      ${symbol ? icon(symbol) : ''}${label} <b>${count}</b></button>`;
    root.querySelector('#statusChips').innerHTML = [
      chip('', 'All', counts.total),
      chip('online', 'Online', counts.online, 'ok', 'ok'),
      chip('delayed', 'Delayed', counts.delayed, 'clock', 'warn'),
      chip('offline', 'Offline', counts.offline, 'x', 'bad'),
      counts.readFailed || state.status === 'failed' ? chip('failed', 'Meter read failed', counts.readFailed, 'warn', 'bad') : '',
      counts.unsigned || state.status === 'unsigned' ? chip('unsigned', 'Unsigned', counts.unsigned, 'lock', '') : '',
    ].join('');
  }

  function renderHead() {
    const th = (key, extra = '') => {
      const sorted = state.sort === key ? ` aria-sort="${state.dir === 'asc' ? 'ascending' : 'descending'}"` : '';
      return `<th class="sort ${extra}" data-sort="${key}" tabindex="0"${sorted}>${SORTS[key].label}</th>`;
    };
    root.querySelector('thead').innerHTML = `<tr>${th('meter')}${th('status')}${th('last')}<th>Last read</th>
      <th class="num">Voltage R/Y/B</th><th class="num p2">Current (avg)</th>${th('power', 'num')}${th('energy', 'num p2')}
      ${th('fw', 'p3')}<th class="p3">Issues</th></tr>`;
  }

  function renderRows() {
    const body = root.querySelector('tbody');
    const rows = visible();
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (state.page > pages) state.page = pages;
    if (data.meters.length === 0) {
      body.innerHTML = emptyRow(COLUMNS, 'No device has sent data yet', 'A device appears here after its first message reaches the device port.');
    } else if (rows.length === 0) {
      body.innerHTML = emptyRow(COLUMNS, 'No meters match these filters', 'Clear the search or choose another status.');
    } else {
      body.innerHTML = rows.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE).map((m) => `<tr class="${m.status === 'offline' ? 'stale' : ''}">
        <td class="full"><a class="link" href="#/meters/${encodeURIComponent(m.id)}">${esc(meterName(m))}</a><span class="sub">${esc([...meterIds(m), m.manufacturer].join(' · ') || ' ')}</span></td>
        <td data-l="Status">${statusBadge(m.status)}</td>
        <td data-l="Last message">${timeCell(m.lastSeen)}</td>
        <td data-l="Last read">${retBadge(m.lastReadAt ? m.lastRet : null)}</td>
        <td class="num val" data-l="Voltage R/Y/B">${esc(voltageText(m))}</td>
        <td class="num val p2" data-l="Current (avg)">${esc(currentText(m))}</td>
        <td class="num val" data-l="Active power">${esc(valueText(v(m, 'kw'), 3))}</td>
        <td class="num val p2" data-l="Energy import">${esc(valueText(v(m, 'kwh'), 2))}</td>
        <td class="p3" data-l="Firmware"><span class="mono">${esc(m.fw || '—')}</span> ${signedBadge(m.verified)}</td>
        <td class="p3 wrap" data-l="Issues">${m.issues.length ? issueList(m.issues) : '<span class="muted">—</span>'}</td>
      </tr>`).join('');
    }
    root.querySelector('.pager').innerHTML = pager(state.page, PAGE_SIZE, rows.length, 'meters')
      .replace('</span>', ' · values of offline meters shown greyed</span>');
  }

  function render() {
    renderChips();
    renderRows();
  }

  const onSearch = debounce(() => {
    state.search = root.querySelector('#meterSearch').value.trim();
    state.page = 1;
    renderRows();
  }, 200);

  function sortBy(key) {
    if (state.sort === key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
    else {
      state.sort = key;
      state.dir = SORTS[key].first;
    }
    state.page = 1;
    renderHead();
    renderRows();
  }

  return {
    mount(element) {
      root = element;
      context.setCrumb('Meters');
      root.innerHTML = `<section class="panel">
        <div class="toolbar">
          <div class="grow"><input id="meterSearch" type="search" placeholder="Search name, IMEI, serial, manufacturer, firmware, IP" aria-label="Search meters"></div>
          <div class="chips" id="statusChips" role="group" aria-label="Status filter"></div>
        </div>
        <div class="tscroll"><table class="cards"><thead></thead><tbody>${skeletonRows(COLUMNS)}</tbody></table></div>
        <div class="pager"></div>
      </section>`;
      root.querySelector('#meterSearch').value = state.search;
      renderHead();
      root.querySelector('#meterSearch').addEventListener('input', onSearch);
      root.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-status]');
        if (chip) {
          state.status = chip.dataset.status;
          state.page = 1;
          return render();
        }
        const header = e.target.closest('th[data-sort]');
        if (header) return sortBy(header.dataset.sort);
        const page = e.target.closest('[data-page]');
        if (page && !page.disabled) {
          state.page = Number(page.dataset.page);
          return renderRows();
        }
        if (e.target.closest('[data-action=retry]')) context.reload('manual');
      });
      root.addEventListener('keydown', (e) => {
        const header = e.target.closest('th[data-sort]');
        if (header && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          sortBy(header.dataset.sort);
        }
      });
    },
    update(next) {
      if (!applyRoute(next)) return false;
      root.querySelector('#meterSearch').value = state.search;
      return true;
    },
    async load(signal) {
      const table = root.querySelector('.tscroll');
      table.classList.add('loading');
      try {
        data = await api('/api/meters', { signal });
      } finally {
        table.classList.remove('loading');
      }
      context.setAlertCount(data.counts);
      render();
    },
    refreshMs: () => REFRESH_MS,
    hasData: () => Boolean(data),
    showError(error) {
      root.querySelector('tbody').innerHTML = `<tr><td colspan="${COLUMNS}">${errorBox(error)}</td></tr>`;
    },
  };
}
