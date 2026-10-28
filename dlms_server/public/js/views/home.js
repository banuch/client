// Home: status of every device, today's traffic, and the meters that need
// attention, most urgent first.
import { api } from '../api.js';
import { shortTime, int } from '../format.js';
import { esc, icon, statusBadge, timeCell, agoText, stateBox, errorBox, skeletonRows, issueList, applyGrow } from '../ui.js';

const REFRESH_MS = 30000;

export function createHomeView(route, context) {
  let root;
  let data = null;
  const { settings } = context;

  const LAYOUT = `
    <div class="kpis">${'<div class="kpi"><span class="skeleton"></span><span class="skeleton block"></span></div>'.repeat(6)}</div>
    <section class="panel health" id="health"><span class="skeleton"></span></section>
    <div class="two gap-top">
      <section class="panel"><div class="panel-head"><h3>Needs attention</h3><span class="note" id="attentionCount"></span></div>
        <div id="attentionBody"><table><tbody>${skeletonRows(4, 3)}</tbody></table></div></section>
      <section class="panel"><div class="panel-head"><h3>Status by device firmware</h3></div>
        <div id="firmwareBody" class="tscroll"><table><tbody>${skeletonRows(5, 2)}</tbody></table></div></section>
    </div>`;

  function kpi({ tone = '', symbol, label, value, valueClass = '', note, href }) {
    const tag = href ? 'a' : 'div';
    return `<${tag} class="kpi ${tone}"${href ? ` href="${href}"` : ''}>
      <span class="label">${icon(symbol)}${esc(label)}</span>
      <strong class="${valueClass}">${value}</strong><small>${note}</small></${tag}>`;
  }

  // The legend repeats the numbers so the bar is never the only carrier of meaning.
  function healthBar(counts) {
    const parts = [['online', 'Online'], ['delayed', 'Delayed'], ['offline', 'Offline']].filter(([key]) => counts[key] > 0);
    const share = Math.round((counts.online / counts.total) * 100);
    return `<div class="health-head"><strong>${share}% online</strong><span class="muted">${int(counts.online)} of ${int(counts.total)} devices reporting on time</span></div>
      <div class="health-bar" role="img" aria-label="${esc(parts.map(([key, label]) => `${label} ${counts[key]}`).join(', '))}">
        ${parts.map(([key, label]) => `<span class="seg ${key}" data-grow="${counts[key]}" title="${esc(label)}: ${counts[key]}"></span>`).join('')}</div>
      <div class="health-legend">${parts.map(([key, label]) => `<a href="#/meters?status=${key}"><span class="dot ${key}"></span>${esc(label)} <b>${int(counts[key])}</b></a>`).join('')}</div>`;
  }

  // Readings per hour since local midnight; failed meter reads stack on top.
  function hourBars() {
    const hours = data.hours;
    const elapsed = Math.floor((data.now - data.dayStart) / 3600000);
    const max = Math.max(1, ...hours.map((h) => h.readings));
    const bars = hours.map((h, index) => {
      const x = index * 10;
      if (index > elapsed) return `<rect class="future" x="${x}" y="27" width="8" height="1"/>`;
      const total = h.readings ? Math.max(2, (h.readings / max) * 28) : 1;
      const bad = h.failed ? Math.max(1.5, (h.failed / max) * 28) : 0;
      const title = `${String(index).padStart(2, '0')}:00 · ${int(h.readings)} reading${h.readings === 1 ? '' : 's'}`
        + `${h.failed ? `, ${int(h.failed)} failed` : ''} · ${int(h.logs)} log upload${h.logs === 1 ? '' : 's'}`;
      return `<g><title>${esc(title)}</title><rect class="${h.readings ? 'ok' : 'none'}" x="${x}" y="${28 - total}" width="8" height="${total}"/>${bad ? `<rect class="bad" x="${x}" y="${28 - total}" width="8" height="${Math.min(bad, total)}"/>` : ''}</g>`;
    }).join('');
    return `<svg class="hours" viewBox="0 0 238 28" preserveAspectRatio="none" role="img" aria-label="Readings per hour today">${bars}</svg>`;
  }

  function render() {
    const { counts } = data;
    context.setAlertCount(counts);
    if (counts.total === 0) {
      root.innerHTML = `<div class="panel">${stateBox({
        kind: 'info',
        title: 'No device has sent data yet',
        detail: 'A device appears here after its first reading or log upload reaches the device port.',
      })}</div>`;
      return;
    }
    if (!root.querySelector('.kpis')) root.innerHTML = LAYOUT;

    const last = data.lastMessage;
    const signingOn = settings.signing !== 'off';
    root.querySelector('.kpis').innerHTML = [
      kpi({ symbol: 'meter', label: 'Devices', value: int(counts.total), note: 'Sent data at least once', href: '#/meters' }),
      kpi({ tone: 'ok', symbol: 'ok', label: 'Online', value: int(counts.online), note: `Message within ${settings.onlineAfterMin} min`, href: '#/meters?status=online' }),
      kpi({ tone: counts.delayed ? 'warn' : '', symbol: 'clock', label: 'Delayed', value: int(counts.delayed), note: `${settings.onlineAfterMin}–${settings.offlineAfterMin} min since message`, href: '#/meters?status=delayed' }),
      kpi({ tone: counts.offline ? 'bad' : '', symbol: 'x', label: 'Offline', value: int(counts.offline), note: `No message for ${settings.offlineAfterMin}+ min`, href: '#/meters?status=offline' }),
      kpi({ tone: counts.readFailed ? 'bad' : '', symbol: 'warn', label: 'Meter read failed', value: int(counts.readFailed), note: `Last cycle failed or no reading · ${int(data.failedToday)} failed today`, href: '#/meters?status=failed' }),
      kpi({
        symbol: 'inbox', label: 'Last message', value: esc(last ? shortTime(last.at) : '—'), valueClass: 'time',
        note: last ? `${agoText(last.at)} · ${esc(last.id)}<br>${int(data.readingsToday)} readings, ${int(data.logsToday)} logs today${hourBars()}` : 'Nothing received',
      }),
    ].join('');
    root.querySelector('#health').innerHTML = healthBar(counts)
      + (signingOn && counts.unsigned ? `<div class="health-legend"><a href="#/meters?status=unsigned">${icon('lock')} ${int(counts.unsigned)} device(s) sending unsigned data</a></div>` : '');
    applyGrow(root.querySelector('#health'));

    const list = data.attention;
    root.querySelector('#attentionCount').textContent = list.length ? `${list.length} device${list.length === 1 ? '' : 's'}` : '';
    root.querySelector('#attentionBody').innerHTML = list.length
      ? `<div class="tscroll"><table class="cards"><thead><tr><th>Meter</th><th>Status</th><th>Last message</th><th>Issue</th></tr></thead><tbody>
        ${list.map((m) => `<tr class="row-link" data-href="#/meters/${encodeURIComponent(m.id)}">
          <td class="full"><a class="link" href="#/meters/${encodeURIComponent(m.id)}">${esc(m.serial || m.id)}</a><span class="sub">${esc([m.serial ? m.id : null, m.manufacturer].filter(Boolean).join(' · '))}</span></td>
          <td data-l="Status">${statusBadge(m.status)}</td>
          <td data-l="Last message">${timeCell(m.lastSeen)}</td>
          <td class="wrap" data-l="Issue">${issueList(m.issues)}</td>
        </tr>`).join('')}</tbody></table></div>`
      : stateBox({ kind: 'good', title: 'All devices are fine', detail: `Every device sent a message within ${settings.onlineAfterMin} min and its last meter read succeeded.` });

    const cell = (value, tone) => `<td class="num${value ? ` ${tone}` : ' zero'}">${int(value)}</td>`;
    root.querySelector('#firmwareBody').innerHTML = `<table><thead><tr><th>Firmware</th><th class="num">Online</th><th class="num">Delayed</th><th class="num">Offline</th><th class="num">Total</th></tr></thead><tbody>
      ${data.byFirmware.map((r) => `<tr><td class="mono">${esc(r.fw)}</td>${cell(r.online, '')}${cell(r.delayed, 'warn')}${cell(r.offline, 'bad')}<td class="num total">${int(r.total)}</td></tr>`).join('')}
      </tbody></table>`;
  }

  return {
    mount(element) {
      root = element;
      context.setCrumb('Home');
      root.innerHTML = LAYOUT;
      root.addEventListener('click', (e) => {
        if (e.target.closest('[data-action=retry]')) context.reload('manual');
        // Whole rows open their meter; real links inside keep normal behaviour.
        const row = e.target.closest('tr[data-href]');
        if (row && !e.target.closest('a') && !window.getSelection().toString()) location.hash = row.dataset.href;
      });
    },
    async load(signal) {
      data = await api('/api/fleet', { signal });
      render();
    },
    refreshMs: () => REFRESH_MS,
    hasData: () => Boolean(data),
    showError(error) {
      root.innerHTML = `<div class="panel">${errorBox(error)}</div>`;
    },
  };
}
