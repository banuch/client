'use strict';
// =============================================================================
//  log-store.js  --  serial log files
//
//    <logDir>/<deviceId>/<YYYY-MM-DD>.log     (date in cfg.timezone)
//
//  Each upload is appended as-is, after one separator line so uploads can be
//  told apart. deviceId is checked by framing.js (no "." or ".." possible).
// =============================================================================
const fs = require('fs');
const path = require('path');

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function createLogStore({ logDir, timezone }) {
  fs.mkdirSync(logDir, { recursive: true });
  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });

  const day = (ms) => dayFmt.format(new Date(ms));
  const deviceDir = (deviceId) => path.join(logDir, deviceId);

  /** Append one upload. Returns the file name (relative to the device folder). */
  function append({ deviceId, receivedAt, boot, seq, bytes, dropped, uptimeS, verified, body }) {
    const dir = deviceDir(deviceId);
    fs.mkdirSync(dir, { recursive: true });
    const file = `${day(receivedAt)}.log`;
    const sep = `\n===== ${timeFmt.format(new Date(receivedAt))} upload boot=${boot} seq=${seq} ` +
      `bytes=${bytes} dropped=${dropped} uptime=${uptimeS}s ${verified ? 'verified' : 'UNVERIFIED'} =====\n`;
    const text = body.toString('utf8').replace(/\r\n/g, '\n');
    fs.appendFileSync(path.join(dir, file), sep + text);
    return file;
  }

  /** Dates that have a log file for the device, newest first. */
  function dates(deviceId) {
    try {
      return fs.readdirSync(deviceDir(deviceId))
        .filter((f) => f.endsWith('.log') && DATE.test(f.slice(0, -4)))
        .map((f) => f.slice(0, -4))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  /** Last `bytes` bytes of one day's file, or null if there is none. */
  function tail(deviceId, date, bytes) {
    if (!DATE.test(date)) return null;
    const file = path.join(deviceDir(deviceId), `${date}.log`);
    let fd;
    try {
      fd = fs.openSync(file, 'r');
    } catch {
      return null;
    }
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, bytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return { text: buf.toString('utf8'), size, truncated: len < size };
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Delete log files from days before `beforeMs`. */
  function prune(beforeMs) {
    const cutoff = day(beforeMs);
    let removed = 0;
    for (const id of fs.readdirSync(logDir)) {
      for (const d of dates(id)) {
        if (d < cutoff) {
          fs.rmSync(path.join(deviceDir(id), `${d}.log`), { force: true });
          removed++;
        }
      }
    }
    return removed;
  }

  /** Delete a device's log folder. Returns the number of log files removed. */
  function removeDevice(deviceId) {
    const n = dates(deviceId).length;
    fs.rmSync(deviceDir(deviceId), { recursive: true, force: true });
    return n;
  }

  return { append, dates, tail, prune, removeDevice, today: (ms) => day(ms) };
}

module.exports = { createLogStore };
