// Application shell: hash router, one refresh timer for the visible view,
// sidebar (groups with live counts, icon rail, drawer on small screens),
// meter search, connection indicator, theme, account menu and the
// outdated-data banner.
import { api, isAbort } from './api.js';
import { setTimeZone, zoneLabel, clockTime, ago, durationText, meterName, meterIds } from './format.js';
import { byId, esc, icon, toast, debounce, statusBadge } from './ui.js';
import { createHomeView } from './views/home.js';
import { createMetersView } from './views/meters.js';
import { createMeterView } from './views/meter.js';

const VIEWS = { home: createHomeView, meters: createMetersView, meter: createMeterView };
const settings = { timezone: 'Asia/Kolkata', onlineAfterMin: 35, offlineAfterMin: 90, signing: 'off' };
const RAIL_KEY = 'amr-nav';
const wideMedia = window.matchMedia('(min-width: 1280px)');
const drawerMedia = window.matchMedia('(max-width: 1023px)');

let view = null;
let loadController = null;
let refreshTimer = null;
let lastSuccessAt = null;
let account = { username: null };

const context = {
  settings,
  setCrumb(html) { byId('crumb').innerHTML = html; },
  // Counts next to the Fleet links; the problem ones only when not zero.
  setAlertCount(counts) {
    if (!counts) return;
    const tone = { offline: 'bad', readFailed: 'bad', unsigned: 'warn' };
    document.querySelectorAll('[data-count]').forEach((badge) => {
      const key = badge.dataset.count;
      const n = counts[key] || 0;
      badge.textContent = String(n);
      badge.className = `count${tone[key] && n ? ` ${tone[key]}` : ''}${n || key === 'total' ? '' : ' hidden'}`;
      badge.closest('a').classList.toggle('flag', (key === 'offline' || key === 'readFailed') && n > 0);
    });
  },
  reload: (reason = 'manual') => runLoad(reason),
  syncNav: () => setNav(parseRoute()),
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

// Connection pill: live with the time of the last load, updating, or failed.
function setUpdated(state, detail = '') {
  const box = byId('updated');
  box.className = `conn ${state}`;
  if (state === 'loading') {
    box.innerHTML = '<span class="dot" aria-hidden="true"></span><span class="long">Updating…</span>';
    box.title = 'Loading the latest data';
  } else if (state === 'failed') {
    box.innerHTML = `<span class="dot" aria-hidden="true"></span><span class="long">Connection problem · ${esc(detail)}</span>`;
    box.title = `The latest refresh failed; the page shows ${detail}.`;
  } else {
    box.innerHTML = `<span class="dot" aria-hidden="true"></span><span class="long">Live · ${esc(clockTime(Date.now()))}</span>`;
    box.title = `Data loaded at ${clockTime(Date.now())} (${zoneLabel()}); refreshes every 30 s.`;
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

// Meters filtered by status light up their own Fleet link.
function setNav(next) {
  let section = next.name === 'meter' ? 'meters' : next.name;
  const status = next.name === 'meters' ? next.params.get('status') : null;
  if (status && document.querySelector(`[data-nav="meters:${status}"]`)) section = `meters:${status}`;
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
  setNav(next);
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
  // A new element for each view: listeners a view added to the old one must
  // not act on the next view (renaming one meter renamed the one seen before).
  const old = byId('view');
  const root = old.cloneNode(false);
  old.replaceWith(root);
  view.mount(root);
  window.scrollTo(0, 0);
  runLoad('initial');
}

function closeNav() {
  byId('shell').classList.remove('nav-open');
  byId('menuButton').setAttribute('aria-expanded', 'false');
}

function railPreferred() {
  try { return localStorage.getItem(RAIL_KEY) === 'rail'; } catch { return false; }
}

// Icon rail: always between 1024 and 1279 px, by choice from 1280 px; below
// 1024 px the sidebar is a drawer with labels.
function applyRail() {
  const rail = !drawerMedia.matches && (!wideMedia.matches || railPreferred());
  byId('shell').classList.toggle('rail', rail);
  const button = byId('collapseButton');
  button.classList.toggle('hidden', !wideMedia.matches);
  button.setAttribute('aria-pressed', String(rail));
  button.setAttribute('aria-label', rail ? 'Expand sidebar' : 'Collapse sidebar');
}

function initNav() {
  byId('menuButton').addEventListener('click', () => {
    const open = byId('shell').classList.toggle('nav-open');
    byId('menuButton').setAttribute('aria-expanded', String(open));
  });
  byId('scrim').addEventListener('click', closeNav);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNav(); });
  byId('refreshButton').addEventListener('click', () => runLoad('manual'));
  byId('collapseButton').addEventListener('click', () => {
    try { localStorage.setItem(RAIL_KEY, railPreferred() ? 'full' : 'rail'); } catch { /* lasts for this page */ }
    applyRail();
    hideTip();
  });
  wideMedia.addEventListener('change', applyRail);
  drawerMedia.addEventListener('change', applyRail);
  applyRail();
}

// Tooltips for [data-tip]: sidebar items only while it is an icon rail,
// other elements (icon buttons) always.
let tipBox = null;
function hideTip() {
  tipBox?.remove();
  tipBox = null;
}
function showTip(el) {
  const inSidebar = el.closest('#sidebar');
  if (inSidebar && !byId('shell').classList.contains('rail')) return;
  if (!el.getClientRects().length) return;
  hideTip();
  tipBox = document.createElement('div');
  tipBox.className = 'tip';
  tipBox.setAttribute('role', 'tooltip');
  tipBox.textContent = el.id === 'collapseButton' ? el.getAttribute('aria-label') : el.dataset.tip;
  document.body.append(tipBox);
  const r = el.getBoundingClientRect();
  const t = tipBox.getBoundingClientRect();
  if (inSidebar) {
    tipBox.style.left = `${r.right + 10}px`;
    tipBox.style.top = `${r.top + (r.height - t.height) / 2}px`;
  } else {
    tipBox.style.left = `${Math.max(8, Math.min(innerWidth - t.width - 8, r.left + (r.width - t.width) / 2))}px`;
    tipBox.style.top = `${r.bottom + 8}px`;
  }
}
function initTips() {
  const target = (e) => e.target.closest?.('[data-tip]');
  document.addEventListener('mouseover', (e) => { const el = target(e); if (el) showTip(el); });
  document.addEventListener('mouseout', (e) => { if (target(e)) hideTip(); });
  document.addEventListener('focusin', (e) => {
    const el = target(e);
    if (el && el.matches(':focus-visible')) showTip(el);
    else hideTip();
  });
  document.addEventListener('focusout', hideTip);
  document.addEventListener('click', hideTip);
  window.addEventListener('scroll', hideTip, { passive: true });
}

// The theme button flips light/dark; the account menu also offers "System".
function syncThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark';
  byId('themeButton').querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  byId('themeButton').dataset.tip = dark ? 'Switch to light theme' : 'Switch to dark theme';
}

function initTheme() {
  syncThemeButton();
  byId('themeButton').addEventListener('click', () => {
    window.amrTheme.set(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
  // Charts take their colours when drawn, so the page is drawn again.
  document.addEventListener('themechange', () => {
    syncThemeButton();
    if (!byId('accountMenu').classList.contains('hidden')) renderAccountMenu();
    runLoad('theme');
  });
}

// Account menu: who is signed in, theme, the server's status settings, log out.
function renderAccountMenu() {
  const pref = window.amrTheme.get();
  const option = (value, label, symbol) => `<button type="button" data-theme-pref="${value}" class="${pref === value ? 'active' : ''}" aria-pressed="${pref === value}">${icon(symbol)}${label}</button>`;
  const signing = { off: 'not checked (no MASTER_SECRET)', checked: 'checked, unsigned accepted', required: 'required' }[settings.signing];
  byId('accountMenu').innerHTML = `<div class="menu-head"><span class="avatar" aria-hidden="true">${esc((account.username || 'V')[0])}</span>
      <div><strong>${esc(account.username || 'Viewer')}</strong><small>${settings.login ? 'Signed in' : 'No login on this server'}</small></div></div>
    <div class="menu-label">Theme</div>
    <div class="segmented" role="group" aria-label="Theme">${option('system', 'System', 'monitor')}${option('light', 'Light', 'sun')}${option('dark', 'Dark', 'moon')}</div>
    <div class="menu-label">Server settings</div>
    <div class="menu-info">Online = message within ${esc(settings.onlineAfterMin)} min<br>Offline after ${esc(settings.offlineAfterMin)} min without a message<br>
      Signatures ${esc(signing || settings.signing)}<br>Times in ${esc(zoneLabel())} (${esc(settings.timezone)})</div>
    ${settings.login ? `<div class="menu-sep"></div><button class="menu-item danger" type="button" data-action="logout">${icon('logout')}Log out</button>` : ''}`;
}

function closeMenu() {
  byId('accountMenu').classList.add('hidden');
  byId('accountButton').setAttribute('aria-expanded', 'false');
}

function initAccountMenu() {
  const button = byId('accountButton');
  const menu = byId('accountMenu');
  button.addEventListener('click', () => {
    if (!menu.classList.contains('hidden')) return closeMenu();
    renderAccountMenu();
    menu.classList.remove('hidden');
    button.setAttribute('aria-expanded', 'true');
    menu.querySelector('button.active, button')?.focus();
  });
  menu.addEventListener('click', (e) => {
    const pref = e.target.closest('[data-theme-pref]');
    if (pref) window.amrTheme.set(pref.dataset.themePref);
    if (e.target.closest('[data-action=logout]')) logOut();
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) closeMenu(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.classList.contains('hidden')) {
      closeMenu();
      button.focus();
    }
  });
}

function setAccount(username) {
  account = { username };
  byId('accountName').textContent = username || 'Viewer';
  byId('avatar').textContent = (username || 'V')[0];
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
  const box = byId('globalSearch');
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
            <span><b>${esc(meterName(m))}</b><small>${esc([...meterIds(m), m.manufacturer].filter(Boolean).join(' · '))}</small></span>
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
  // On phones the box is an icon that opens over the top bar.
  input.addEventListener('focus', () => {
    box.classList.add('open');
    if (input.value.trim()) lookup();
  });
  input.addEventListener('blur', () => setTimeout(() => { if (!box.contains(document.activeElement)) box.classList.remove('open'); }, 150));
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
  document.addEventListener('click', (e) => { if (!box.contains(e.target)) hide(); });
  // Ctrl+K (or "/" outside a text field) jumps to the search box.
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') || (e.key === '/' && !typing)) {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
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
  initTips();
  initTheme();
  initAccountMenu();
  initSearch();
  startTicker();
  try {
    Object.assign(settings, await api('/api/config'));
  } catch {
    // The defaults above match the server defaults.
  }
  setTimeZone(settings.timezone);
  byId('navFoot').textContent = `Times in ${zoneLabel()} · online within ${settings.onlineAfterMin} min`;
  setAccount(null);
  if (settings.login) {
    fetch('auth/me').then((r) => (r.ok ? r.json() : null)).then((me) => setAccount(me?.username || null)).catch(() => {});
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

  // The sidebar counts come with the data of Home and Meters; a meter page
  // fetches them once.
  if (parseRoute().name === 'meter') api('/api/fleet').then((f) => context.setAlertCount(f.counts)).catch(() => {});
}

initialize();
