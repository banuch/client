// One meter: header with status and banners, then tabs. The header and the
// live tabs refresh on the timer; history tabs keep their filters and reload
// only when opened, filtered, or refreshed by hand.
import { api, devicePath, isAbort } from '../api.js';
import { dateTime, meterName } from '../format.js';
import { esc, icon, statusBadge, agoText, stateBox, errorBox, signedBadge, retBadge, toast, crumbs, confirmDialog, ensureChart } from '../ui.js';
import { O, valueMap, textOf } from '../obis.js';
import { renderInstant, renderEnergy, renderInfo, renderComm, createValuesTab } from './meter-live.js';
import { createTrendsTab, createProfilesTab, createBillingTab, createEventsTab, createReadingsTab, createLogTab } from './meter-history.js';

const REFRESH_MS = 30000;
const TABS = [
  ['instant', 'Instantaneous'], ['energy', 'Energy & demand'], ['info', 'Meter info'], ['trends', 'Trends'],
  ['profiles', 'Load profile'], ['billing', 'Billing'], ['events', 'Events'], ['comm', 'Communication'],
  ['values', 'All values'], ['readings', 'Read cycles'], ['log', 'Device log'],
];
const LIVE_TABS = { instant: renderInstant, energy: renderEnergy, info: renderInfo, comm: renderComm };
const HISTORY_TABS = {
  values: createValuesTab,
  trends: createTrendsTab,
  profiles: createProfilesTab,
  billing: createBillingTab,
  events: createEventsTab,
  readings: createReadingsTab,
  log: createLogTab,
};

const validTab = (name) => (TABS.some(([key]) => key === name) ? name : 'instant');

export function createMeterView(route, context) {
  const id = route.id;
  let tab = validTab(route.tab);
  let root;
  let meter = null;
  let meters = [];
  let latest = null;
  let renaming = false;
  let history = null;
  let historyName = null;

  const href = (name) => `#/meters/${encodeURIComponent(id)}/${name}`;
  const pane = () => root.querySelector('#meterPane');

  function renderTabs() {
    root.querySelector('.tabs').innerHTML = TABS.map(([key, label]) => `<a class="tab${key === tab ? ' active' : ''}" href="${href(key)}" role="tab"
      aria-selected="${key === tab}" aria-controls="meterPane" tabindex="${key === tab ? 0 : -1}">${label}</a>`).join('');
    root.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function renderName() {
    const title = root.querySelector('#meterTitle');
    if (renaming) {
      title.innerHTML = `<form class="rename" id="renameForm" novalidate>
        <input type="text" id="nameInput" maxlength="64" value="${esc(meter.name || '')}" placeholder="e.g. Substation 3 – Feeder B" aria-label="Device name" aria-describedby="nameHint">
        <button class="btn small primary" type="submit">Save</button>
        <button class="btn small" type="button" data-action="rename-cancel">Cancel</button>
        <span class="hint" id="nameHint" aria-live="polite"></span></form>`;
      checkName(title.querySelector('#nameInput'));
      const input = title.querySelector('#nameInput');
      input.focus();
      input.select();
      return;
    }
    title.innerHTML = `${esc(meterName(meter))}
      <button class="btn small icon-only ghost" type="button" data-action="rename" data-tip="Rename device" aria-label="Rename device">${icon('edit')}</button>
      <button class="btn small icon-only ghost" type="button" data-action="delete" data-tip="Delete meter and all its data" aria-label="Delete meter and all its data">${icon('trash')}</button>
      ${statusBadge(meter.status)} ${signedBadge(meter.verified)}`;
  }

  // The same rules as the server (src/http-server.js parseName), shown while typing.
  function checkName(input) {
    const value = input.value.trim();
    const hint = root.querySelector('#nameHint');
    const length = [...value].length;
    // eslint-disable-next-line no-control-regex
    const error = /[\u0000-\u001f\u007f-\u009f]/.test(value) ? 'Names cannot contain control characters.'
      : length > 64 ? 'Names can have up to 64 characters.' : '';
    input.setAttribute('aria-invalid', String(Boolean(error)));
    hint.classList.toggle('error', Boolean(error));
    hint.textContent = error || (value ? `${length}/64 characters` : meter.name ? 'Saving an empty name clears it; the page then shows the serial or IMEI.' : 'Up to 64 characters.');
    root.querySelector('#renameForm [type=submit]').disabled = Boolean(error) || value === (meter.name || '');
    return !error;
  }

  async function saveName(value) {
    const button = root.querySelector('#renameForm [type=submit]');
    if (!value.trim() && meter.name) {
      const ok = await confirmDialog({
        title: 'Clear the device name?',
        message: `"${meter.name}" will be removed. The page then shows this device by its ${meter.serial ? 'serial' : 'IMEI'}.`,
        confirmLabel: 'Clear name',
      });
      if (!ok || !root.querySelector('#renameForm')) return;
    }
    button.disabled = true;
    try {
      const saved = await api(devicePath(id, '/name'), { method: 'PUT', body: { name: value } });
      renaming = false;
      toast(saved.name ? `Device renamed to "${saved.name}".` : 'Device name cleared.');
      context.reload('manual');
    } catch (error) {
      button.disabled = false;
      toast(error.message, 'warn');
    }
  }

  async function deleteMeter() {
    const name = meterName(meter);
    const ok = await confirmDialog({
      title: `Delete ${name}?`,
      message: `Every reading, load profile, event and billing row and serial log stored for IMEI ${meter.id} will be deleted. This cannot be undone. If the device is still sending, its next message adds it again as a new meter.`,
      confirmLabel: 'Delete meter',
    });
    if (!ok) return;
    try {
      const { removed } = await api(devicePath(id), { method: 'DELETE' });
      toast(`Deleted ${name}: ${removed.readings} readings, ${removed.profileRows} profile rows, ${removed.logFiles} log files.`);
      location.hash = '#/meters';
    } catch (error) {
      toast(error.message, 'warn');
    }
  }

  function renderHeader() {
    const values = valueMap(latest?.values);
    const name = meterName(meter);
    context.setCrumb(crumbs(['Meters', '#/meters'], [name]));
    document.title = `${name} · AMR Data`;
    const ids = [
      meter.name && meter.serial ? `Serial ${meter.serial}` : null,
      meter.name || meter.serial ? `IMEI ${meter.id}` : null,
      meter.manufacturer, meter.fw ? `FW ${meter.fw}` : null,
    ].filter(Boolean);
    const clock = textOf(values, O.clock);
    // The name keeps its form while the timer refreshes the rest of the header.
    const keep = renaming && root.querySelector('#renameForm');
    const focused = keep && keep.contains(document.activeElement) ? document.activeElement : null;
    if (keep) keep.remove();
    root.querySelector('#meterHead').innerHTML = `
      <div><span class="icon-tile c-indigo" aria-hidden="true">${icon('meter')}</span><div><h1 id="meterTitle"></h1><div class="ids">${esc(ids.join(' · '))}</div></div></div>
      <div class="facts">
        <div class="fact"><small>Last message</small><b>${esc(dateTime(meter.lastSeen))} · ${agoText(meter.lastSeen)}</b></div>
        <div class="fact"><small>Last meter read</small><b>${meter.lastReadAt ? `${esc(dateTime(meter.lastReadAt))} · ${agoText(meter.lastReadAt)}` : 'None'}</b></div>
        <div class="fact"><small>Read result</small><b>${retBadge(meter.lastReadAt ? meter.lastRet : null)}</b></div>
        ${clock ? `<div class="fact"><small>Meter clock</small><b>${esc(clock)}</b></div>` : ''}
      </div>`;
    if (keep) {
      root.querySelector('#meterTitle').append(keep);
      focused?.focus();
    } else renderName();

    const banners = [];
    const since = (ms) => agoText(ms).replace(' ago', '');
    if (meter.status === 'offline') {
      banners.push(['bad', 'x', `<strong>Device offline: no message for ${since(meter.lastSeen)}.</strong> Values shown are from the last stored reading, not live data.`]);
    } else if (meter.status === 'delayed') {
      banners.push(['warn', 'clock', `<strong>Messages are late: last message ${agoText(meter.lastSeen)}.</strong> Values may be out of date.`]);
    }
    if (!meter.lastReadAt) {
      banners.push(['info', 'minus', '<strong>No meter reading received yet.</strong> The device has only sent logs; the Device log tab shows what it is doing.']);
    } else if (meter.lastRet !== 0) {
      banners.push(['bad', 'warn', `<strong>The last meter read failed (code ${esc(meter.lastRet)}).</strong> Values shown are what the device could read in that cycle; the Device log tab has the detail.`]);
    }
    for (const issue of meter.issues.filter((i) => i.code === 'read_stale')) banners.push(['warn', 'clock', esc(issue.text)]);
    const sameName = meter.name ? meters.filter((m) => m.id !== id && m.name?.toLowerCase() === meter.name.toLowerCase()) : [];
    if (sameName.length) {
      const links = sameName.map((m) => `<a class="link" href="#/meters/${encodeURIComponent(m.id)}">IMEI ${esc(m.id)}</a>`).join(', ');
      banners.push(['warn', 'warn', `<strong>Another device has the same name:</strong> ${links}. Rename one of them to tell them apart.`]);
    }
    root.querySelector('#meterBanner').innerHTML = banners
      .map(([kind, symbol, text]) => `<div class="banner ${kind}" role="status">${icon(symbol)}<div>${text}</div></div>`).join('');
  }

  function closeHistory() {
    history?.destroy?.();
    history = null;
    historyName = null;
  }

  async function renderLiveTab(signal) {
    closeHistory();
    if (!pane().children.length) pane().innerHTML = '<span class="skeleton block"></span>';
    const markup = await LIVE_TABS[tab]({ meter, latest, id, signal });
    pane().innerHTML = markup.html ?? markup;
    markup.after?.(pane());
  }

  async function loadHistoryTab(signal) {
    if (historyName !== tab) {
      closeHistory();
      history = HISTORY_TABS[tab]({ id, meter, latest, name: () => meter?.name });
      historyName = tab;
      pane().innerHTML = '';
      const holder = document.createElement('div');
      holder.className = 'panel';
      pane().append(holder);
      history.mount(holder);
    }
    history.setLatest?.(latest);
    try {
      await history.load(signal);
    } catch (error) {
      // History tabs show their own errors; only cancellation propagates.
      if (isAbort(error)) throw error;
    }
  }

  function layout() {
    closeHistory();
    root.innerHTML = `<div class="mhead" id="meterHead"><span class="skeleton title"></span></div>
      <div id="meterBanner"></div>
      <nav class="tabs" role="tablist" aria-label="Meter sections"></nav>
      <div id="meterPane" role="tabpanel" aria-label="Meter section"><span class="skeleton block"></span></div>`;
    renderTabs();
  }

  return {
    mount(element) {
      root = element;
      context.setCrumb(crumbs(['Meters', '#/meters'], [id]));
      layout();
      root.addEventListener('click', (e) => {
        if (e.target.closest('#meterPane > .state [data-action=retry], #meterRetry')) context.reload('manual');
        if (e.target.closest('[data-action=rename]')) { renaming = true; renderName(); }
        if (e.target.closest('[data-action=rename-cancel]')) { renaming = false; renderName(); }
        if (e.target.closest('[data-action=delete]')) deleteMeter();
      });
      root.addEventListener('submit', (e) => {
        if (e.target.id !== 'renameForm') return;
        e.preventDefault();
        saveName(e.target.querySelector('#nameInput').value);
      });
      root.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && e.target.id === 'nameInput') { renaming = false; renderName(); }
        // Arrow keys, Home and End move between the tabs.
        const current = e.target.closest('.tab');
        const moves = { ArrowRight: 1, ArrowLeft: -1, Home: -TABS.length, End: TABS.length };
        if (current && e.key in moves) {
          e.preventDefault();
          const keys = TABS.map(([key]) => key);
          const i = Math.max(0, Math.min(keys.length - 1, keys.indexOf(tab) + moves[e.key]));
          location.hash = href(keys[i]);
        }
      });
      root.addEventListener('input', (e) => { if (e.target.id === 'nameInput') checkName(e.target); });
    },
    update(next) {
      if (next.id !== id) return false;
      const nextTab = validTab(next.tab);
      if (nextTab !== tab) {
        tab = nextTab;
        // Keyboard users keep focus on the tab bar (arrow keys move between tabs).
        const tabFocused = root.querySelector('.tabs').contains(document.activeElement);
        renderTabs();
        if (tabFocused) root.querySelector('.tab.active').focus();
        if (LIVE_TABS[tab]) pane().innerHTML = '<span class="skeleton block"></span>';
      }
      return true;
    },
    async load(signal, reason) {
      // Chart.js loads alongside the data; the charted tabs need it.
      const [list, reading] = await Promise.all([
        api('/api/meters', { signal }),
        api(devicePath(id, '/latest'), { signal }),
        ensureChart(),
      ]);
      meters = list.meters;
      meter = meters.find((m) => m.id === id);
      if (!meter) throw Object.assign(new Error('unknown'), { status: 404 });
      latest = reading;
      context.setAlertCount(list.counts);
      if (!root.querySelector('#meterHead')) layout();
      renderHeader();
      if (LIVE_TABS[tab]) await renderLiveTab(signal);
      else if (reason !== 'auto' || historyName !== tab || tab === 'values') await loadHistoryTab(signal);
    },
    refreshMs: () => REFRESH_MS,
    hasData: () => Boolean(meter),
    showError(error) {
      meter = null;
      renaming = false;
      closeHistory();
      document.title = 'AMR Data';
      if (error.status === 404) {
        root.innerHTML = `<div class="panel">${stateBox({ kind: 'info', title: 'Meter not found', detail: `No device with ID "${id}" has sent data to this server.` })}
          <p class="state"><a class="btn" href="#/meters">Back to meters</a></p></div>`;
        return;
      }
      root.innerHTML = `<div class="panel">${errorBox(error).replace('data-action="retry"', 'id="meterRetry"')}</div>`;
    },
    destroy() {
      closeHistory();
      document.title = 'AMR Data';
    },
  };
}
