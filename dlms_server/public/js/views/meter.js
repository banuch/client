// One meter: header with status and banners, then tabs. The header and the
// live tabs refresh on the timer; history tabs keep their filters and reload
// only when opened, filtered, or refreshed by hand.
import { api, devicePath, isAbort } from '../api.js';
import { dateTime } from '../format.js';
import { esc, icon, statusBadge, agoText, stateBox, errorBox, signedBadge, retBadge } from '../ui.js';
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
  let latest = null;
  let history = null;
  let historyName = null;

  const href = (name) => `#/meters/${encodeURIComponent(id)}/${name}`;
  const pane = () => root.querySelector('#meterPane');

  function renderTabs() {
    root.querySelector('.tabs').innerHTML = TABS.map(([key, label]) => `<a class="tab${key === tab ? ' active' : ''}" href="${href(key)}" role="tab" aria-selected="${key === tab}">${label}</a>`).join('');
  }

  function renderHeader() {
    const values = valueMap(latest?.values);
    const name = meter.serial || meter.id;
    context.setCrumb(`<a href="#/meters">Meters</a> <span>/ ${esc(name)}</span>`);
    document.title = `${name} · AMR Data`;
    const ids = [meter.serial ? `IMEI ${meter.id}` : null, meter.manufacturer, meter.fw ? `FW ${meter.fw}` : null].filter(Boolean);
    const clock = textOf(values, O.clock);
    root.querySelector('#meterHead').innerHTML = `
      <div><h1>${esc(name)} ${statusBadge(meter.status)} ${signedBadge(meter.verified)}</h1><div class="ids">${esc(ids.join(' · '))}</div></div>
      <div class="facts">
        <div class="fact"><small>Last message</small><b>${esc(dateTime(meter.lastSeen))} · ${agoText(meter.lastSeen)}</b></div>
        <div class="fact"><small>Last meter read</small><b>${meter.lastReadAt ? `${esc(dateTime(meter.lastReadAt))} · ${agoText(meter.lastReadAt)}` : 'None'}</b></div>
        <div class="fact"><small>Read result</small><b>${retBadge(meter.lastReadAt ? meter.lastRet : null)}</b></div>
        ${clock ? `<div class="fact"><small>Meter clock</small><b>${esc(clock)}</b></div>` : ''}
      </div>`;

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
      history = HISTORY_TABS[tab]({ id, meter, latest });
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
      <div id="meterPane"><span class="skeleton block"></span></div>`;
    renderTabs();
  }

  return {
    mount(element) {
      root = element;
      context.setCrumb(`<a href="#/meters">Meters</a> <span>/ ${esc(id)}</span>`);
      layout();
      root.addEventListener('click', (e) => {
        if (e.target.closest('#meterPane > .state [data-action=retry], #meterRetry')) context.reload('manual');
      });
    },
    update(next) {
      if (next.id !== id) return false;
      const nextTab = validTab(next.tab);
      if (nextTab !== tab) {
        tab = nextTab;
        renderTabs();
        if (LIVE_TABS[tab]) pane().innerHTML = '<span class="skeleton block"></span>';
      }
      return true;
    },
    async load(signal, reason) {
      const [list, reading] = await Promise.all([
        api('/api/meters', { signal }),
        api(devicePath(id, '/latest'), { signal }),
      ]);
      meter = list.meters.find((m) => m.id === id);
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
