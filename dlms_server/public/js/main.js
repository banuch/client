// Application shell: hash router, one refresh timer for the visible view,
// meter search, "updated" indicator and the outdated-data banner.
import { api, isAbort } from './api.js';
import { setTimeZone, zoneLabel, clockTime, ago, durationText, meterName, meterIds } from './format.js';
import { byId, esc, icon, toast, debounce, statusBadge } from './ui.js';
import { createHomeView } from './views/home.js';
import { createMetersView } from './views/meters.js';
import { createMeterView } from './views/meter.js';

const VIEWS = { home: createHomeView, meters: createMetersView, meter: createMeterView };
const settings = { timezone: 'Asia/Kolkata', onlineAfterMin: 35, offlineAfterMin: 90, signing: 'off' };

let view = null;
let loadController = null;
let refreshTimer = null;
let lastSuccessAt = null;

const context = {
  settings,
  setCrumb(html) { byId('crumb').innerHTML = html; },
  setAlertCount(counts) {
    const n = (counts?.offline || 0) + (counts?.readFailed || 0);
    byId('navAlert').textContent = String(n);
    byId('navAlert').classList.toggle('hidden', n === 0);
  },
  reload: (reason = 'manual') => runLoad(reason),
};

function parseRoute() {
  const hash = location.hash.replace(/^#/, '') || '/home';
  const [path, search = ''] = hash.split('?');
  const parts = path.split('/').filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  const params = new URLSearchParams(search);
  if (parts[0] === 'meters' && parts[1]) return { name: 'meter', id: parts[1], tab: parts[2] || 'instant', params };
  if (parts[0] === 'meters') return { name: 'meters', params };
  return { name: 'home', params };
}

function setUpdated(state, detail = '') {
  const box = byId('updated');
  box.classList.toggle('failed', state === 'failed');
  if (state === 'loading') {
    box.innerHTML = '<span class="spinner" aria-hidden="true"></span><span class="long">Updating…</span>';
  } else if (state === 'failed') {
    box.innerHTML = `${icon('warn')}<span><span class="long">Update failed · </span>${esc(detail)}</span>`;
    box.title = 'The latest refresh failed; the page shows the data from the time given.';
  } else {
    box.innerHTML = `${icon('clock')}<span><span class="long">Updated </span>${esc(clockTime(Date.now()))}</span>`;
    box.title = `Data loaded at this time (${zoneLabel()}).`;
  }
}

function schedule() {
  clearTimeout(refreshTimer);
  const ms = view?.refreshMs?.();
  if (ms && !document.hidden) refreshTimer = setTimeout(() => runLoad('auto'), ms);
}

async function runLoad(reason) {
  if (!view) return;
  clearTimeout(refreshTimer);
  loadController?.abort();
  const controller = new AbortController();
  loadController = controller;
  const button = byId('refreshButton');
  if (reason === 'manual') button.classList.add('busy');
  setUpdated('loading');
  try {
    await view.load(controller.signal, reason);
    if (controller !== loadController) return;
    lastSuccessAt = Date.now();
    setUpdated('ok');
    updateOutdated();
  } catch (error) {
    if (isAbort(error) || controller !== loadController) return;
    console.error(error);
    const since = lastSuccessAt ? `data from ${clockTime(lastSuccessAt)}` : 'no data';
    setUpdated('failed', since);
    updateOutdated();
    if (view.hasData?.()) {
      if (reason !== 'auto') toast(`${error.message} Showing ${since}.`, 'warn');
    } else {
      view.showError(error);
    }
  } finally {
    if (controller === loadController) {
      button.classList.remove('busy');
      schedule();
    }
  }
}

function setNav(name) {
  const section = name === 'meter' ? 'meters' : name;
  document.querySelectorAll('[data-nav]').forEach((link) => {
    const active = link.dataset.nav === section;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function route() {
  const next = parseRoute();
  closeNav();
  setNav(next.name);
  if (view && view.routeName === next.name && view.update?.(next)) {
    runLoad('route');
    return;
  }
  loadController?.abort();
  clearTimeout(refreshTimer);
  view?.destroy?.();
  lastSuccessAt = null;
  updateOutdated();
  view = VIEWS[next.name](next, context);
  view.routeName = next.name;
  const root = byId('view');
  root.innerHTML = '';
  view.mount(root);
  window.scrollTo(0, 0);
  runLoad('initial');
}

function closeNav() {
  byId('shell').classList.remove('nav-open');
  byId('menuButton').setAttribute('aria-expanded', 'false');
}

function initNav() {
  byId('menuButton').addEventListener('click', () => {
    const open = byId('shell').classList.toggle('nav-open');
    byId('menuButton').setAttribute('aria-expanded', String(open));
  });
  byId('scrim').addEventListener('click', closeNav);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNav(); });
  byId('refreshButton').addEventListener('click', () => runLoad('manual'));
}

async function logOut() {
  loadController?.abort();
  clearTimeout(refreshTimer);
  try {
    await fetch('auth/logout', { method: 'POST', headers: { 'X-AMR-Data': '1' } });
  } catch {
    // The session cookie stays; the sign-in page sends us back here if so.
  }
  location.replace('login.html');
}

// The fleet is small, so search filters the full meter list in the browser.
function initSearch() {
  const input = byId('globalSearchInput');
  const results = byId('searchResults');
  let active = -1;
  let cache = null;

  const hide = () => {
    results.classList.add('hidden');
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };
  const links = () => [...results.querySelectorAll('a')];
  const highlight = (i) => {
    const items = links();
    active = Math.max(-1, Math.min(i, items.length - 1));
    items.forEach((item, n) => item.classList.toggle('active', n === active));
  };

  const lookup = debounce(async () => {
    const term = input.value.trim().toLowerCase();
    if (!term) return hide();
    try {
      if (!cache || Date.now() - cache.at > 30000) cache = { at: Date.now(), meters: (await api('/api/meters')).meters };
      const hits = cache.meters.filter((m) => [m.name, m.id, m.serial, m.manufacturer, m.fw, m.lastIp]
        .some((s) => s && String(s).toLowerCase().includes(term)));
      results.innerHTML = hits.length
        ? hits.slice(0, 8).map((m) => `<a href="#/meters/${encodeURIComponent(m.id)}" role="option">
            <span><b>${esc(meterName(m))}</b><small>${esc([...meterIds(m), m.manufacturer].join(' · '))}</small></span>
            ${statusBadge(m.status)}</a>`).join('')
          + (hits.length > 8 ? `<a href="#/meters?search=${encodeURIComponent(input.value.trim())}"><span>Show all ${hits.length} matches</span></a>` : '')
        : '<div class="none">No meter matches this search.</div>';
      results.classList.remove('hidden');
      input.setAttribute('aria-expanded', 'true');
      active = -1;
    } catch (error) {
      if (!isAbort(error)) {
        results.innerHTML = `<div class="none">${esc(error.message)}</div>`;
        results.classList.remove('hidden');
      }
    }
  }, 200);

  input.addEventListener('input', lookup);
  input.addEventListener('focus', () => { if (input.value.trim()) lookup(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active - 1); }
    else if (e.key === 'Escape') { hide(); input.blur(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const items = links();
      const target = items[active] || (items.length === 1 ? items[0] : null);
      location.hash = target ? target.getAttribute('href') : `#/meters?search=${encodeURIComponent(input.value.trim())}`;
      hide();
      input.blur();
    }
  });
  results.addEventListener('click', (e) => {
    if (e.target.closest('a')) {
      hide();
      input.value = '';
    }
  });
  document.addEventListener('click', (e) => { if (!byId('globalSearch').contains(e.target)) hide(); });
}

// Warns when refreshes have been failing for more than two intervals.
function updateOutdated() {
  const ms = view?.refreshMs?.();
  const outdated = Boolean(ms && lastSuccessAt && !document.hidden && Date.now() - lastSuccessAt > 2 * ms);
  document.body.classList.toggle('data-outdated', outdated);
  const banner = byId('outdated');
  banner.classList.toggle('hidden', !outdated);
  if (outdated) {
    banner.innerHTML = `${icon('warn')}<span>The page has not refreshed for ${esc(durationText((Date.now() - lastSuccessAt) / 1000))}.
      Statuses and values below are from ${esc(clockTime(lastSuccessAt))} and may no longer be current.</span>`;
  }
}

// Keeps every "… ago" text current between data refreshes.
function startTicker() {
  setInterval(() => {
    document.querySelectorAll('[data-ago]').forEach((e) => { e.textContent = ago(Number(e.dataset.ago)); });
    updateOutdated();
  }, 15000);
}

async function initialize() {
  initNav();
  initSearch();
  startTicker();
  try {
    Object.assign(settings, await api('/api/config'));
  } catch {
    // The defaults above match the server defaults.
  }
  setTimeZone(settings.timezone);
  const signing = { off: 'not checked (no MASTER_SECRET)', checked: 'checked, unsigned accepted', required: 'required' }[settings.signing];
  byId('navFoot').innerHTML = `Online = message within ${esc(settings.onlineAfterMin)} min<br>
    Offline after ${esc(settings.offlineAfterMin)} min<br>Signatures ${esc(signing || settings.signing)}<br>
    Times in ${esc(zoneLabel())} (${esc(settings.timezone)})`;
  if (settings.login) {
    byId('logoutButton').classList.remove('hidden');
    byId('logoutButton').addEventListener('click', logOut);
  }

  document.addEventListener('visibilitychange', () => {
    updateOutdated();
    if (document.hidden) {
      clearTimeout(refreshTimer);
      return;
    }
    const ms = view?.refreshMs?.();
    if (ms && (!lastSuccessAt || Date.now() - lastSuccessAt >= ms)) runLoad('auto');
    else schedule();
  });
  window.addEventListener('hashchange', route);
  route();

  // The meters badge in the sidebar needs the counts on every page.
  if (parseRoute().name === 'meter') api('/api/fleet').then((f) => context.setAlertCount(f.counts)).catch(() => {});
}

initialize();
