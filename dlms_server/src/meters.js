'use strict';
// =============================================================================
//  meters.js  --  meter list and fleet overview for the web page
//
//  A device's status comes from the last time it sent anything (reading or
//  log): online up to ONLINE_AFTER_MIN, delayed up to OFFLINE_AFTER_MIN, then
//  offline. Problems with the meter itself (a failed read cycle, no reading
//  for a long time) are listed as issues next to the status.
//
//  The list shows a few values of each device's latest reading, picked by
//  OBIS code (names as in firmware/obis_names.h). Units come from the device.
// =============================================================================

const SUMMARY_OBIS = {
  serial: '0.0.96.1.0.255',
  manufacturer: '0.0.96.1.1.255',
  vR: '1.0.32.7.0.255',
  vY: '1.0.52.7.0.255',
  vB: '1.0.72.7.0.255',
  v: '1.0.12.7.0.255',          // single phase meters
  iR: '1.0.31.7.0.255',
  iY: '1.0.51.7.0.255',
  iB: '1.0.71.7.0.255',
  i: '1.0.11.7.0.255',
  kw: '1.0.1.7.0.255',
  kwh: '1.0.1.8.0.255',
  pf: '1.0.13.7.0.255',
};
const KEY_BY_OBIS = Object.fromEntries(Object.entries(SUMMARY_OBIS).map(([k, o]) => [o, k]));

// Lower sorts first in "needs attention".
const SEVERITY = { offline: 0, read_failed: 1, delayed: 2, no_reading: 3, read_stale: 3, unsigned: 4 };

function durationText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
}

function meterStatus(lastSeen, now, cfg) {
  const age = now - lastSeen;
  if (age <= cfg.onlineAfterMin * 60000) return 'online';
  if (age <= cfg.offlineAfterMin * 60000) return 'delayed';
  return 'offline';
}

function meterIssues(m, now, cfg) {
  const out = [];
  if (m.status === 'offline') out.push({ code: 'offline', text: `No message for ${durationText(now - m.lastSeen)}` });
  if (m.status === 'delayed') out.push({ code: 'delayed', text: `Last message ${durationText(now - m.lastSeen)} ago` });
  if (!m.lastReadAt) out.push({ code: 'no_reading', text: 'No meter reading received (logs only)' });
  else if (m.lastRet !== 0) out.push({ code: 'read_failed', text: `Last meter read failed (code ${m.lastRet})` });
  if (m.lastReadAt && m.status === 'online' && now - m.lastReadAt > cfg.offlineAfterMin * 60000) {
    out.push({ code: 'read_stale', text: `Meter not read for ${durationText(now - m.lastReadAt)}` });
  }
  if (cfg.masterSecret && !m.verified) out.push({ code: 'unsigned', text: 'Last message was not signed' });
  return out;
}

/** Device rows (db.listDevices) and their summary values (db.summaryValues) -> meter list. */
function buildMeters(devices, values, now, cfg) {
  const byDevice = new Map();
  for (const v of values) {
    const key = KEY_BY_OBIS[v.obis];
    if (!key) continue;
    if (!byDevice.has(v.deviceId)) byDevice.set(v.deviceId, {});
    byDevice.get(v.deviceId)[key] = v.num !== null ? { num: v.num, unit: v.unit } : { text: v.text };
  }
  return devices.map((d) => {
    const vals = byDevice.get(d.id) || {};
    const m = {
      id: d.id,
      serial: vals.serial?.text ?? (vals.serial?.num != null ? String(vals.serial.num) : null),
      manufacturer: vals.manufacturer?.text ?? null,
      status: meterStatus(d.lastSeen, now, cfg),
      firstSeen: d.firstSeen,
      lastSeen: d.lastSeen,
      lastIp: d.lastIp,
      fw: d.fw,
      verified: !!d.verified,
      lastReadAt: d.lastReadAt ?? null,
      lastRet: d.lastRet ?? null,
      lastValueCount: d.lastValueCount ?? 0,
      lastLogAt: d.lastLogAt ?? null,
      values: {},
    };
    for (const [k, v] of Object.entries(vals)) if (k !== 'serial' && k !== 'manufacturer' && v.num !== undefined) m.values[k] = v;
    m.issues = meterIssues(m, now, cfg);
    return m;
  });
}

function countStatuses(meters) {
  const counts = { total: meters.length, online: 0, delayed: 0, offline: 0, readFailed: 0, unsigned: 0 };
  for (const m of meters) {
    counts[m.status]++;
    if (m.issues.some((i) => i.code === 'read_failed' || i.code === 'no_reading')) counts.readFailed++;
    if (m.issues.some((i) => i.code === 'unsigned')) counts.unsigned++;
  }
  return counts;
}

/** Meters with at least one issue, most urgent first. */
function attention(meters) {
  const rank = (m) => Math.min(...m.issues.map((i) => SEVERITY[i.code]));
  return meters.filter((m) => m.issues.length).sort((a, b) => rank(a) - rank(b) || a.lastSeen - b.lastSeen);
}

function byFirmware(meters) {
  const map = new Map();
  for (const m of meters) {
    const fw = m.fw || 'unknown';
    if (!map.has(fw)) map.set(fw, { fw, online: 0, delayed: 0, offline: 0, total: 0 });
    const row = map.get(fw);
    row[m.status]++;
    row.total++;
  }
  return [...map.values()].sort((a, b) => b.total - a.total || a.fw.localeCompare(b.fw));
}

/** Epoch ms of the most recent midnight in timeZone at or before ms. */
function dayStart(ms, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offset = wall - Math.floor(ms / 1000) * 1000;
  return Date.UTC(p.year, p.month - 1, p.day) - offset;
}

module.exports = { SUMMARY_OBIS, meterStatus, buildMeters, countStatuses, attention, byFirmware, dayStart, durationText };
