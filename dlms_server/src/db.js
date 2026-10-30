'use strict';
// =============================================================================
//  db.js  --  SQLite storage (better-sqlite3, synchronous)
//
//  Duplicates (a message resent after a lost SEND OK) are dropped by
//  (device_id, boot, seq). boot 0 means "no boot id" (2.0.0 log bridge):
//  those are never treated as duplicates because seq restarts at each boot.
//
//  Profile rows (FW 2.0.2) are stored once per (device, profile, row_key):
//  the firmware may send a row again after an outage or a reboot. A row with
//  a time is keyed by that time, and a resend replaces its cells. Event rows
//  (several may share a second) and rows without a time (name plate) are
//  keyed by a hash of time and cells. The columns of each profile are kept
//  in profile_columns (latest wins).
//
//  Billing profile: the open month's row carries the meter's current time as
//  its billing date, so its time changes every cycle. The newest billing row
//  of a reading, when its time is within OPEN_ROW_S of the meter clock in
//  the same reading, is that open row: it is keyed "open" and replaced in
//  place. When the month closes the meter sends it with its real billing
//  date, which is stored as a normal row.
// =============================================================================
const crypto = require('crypto');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  last_ip     TEXT,
  fw          TEXT,
  verified    INTEGER NOT NULL DEFAULT 0,   -- last message was signed and checked
  last_reading_id INTEGER,
  name        TEXT                          -- set on the page; device messages never change it
);
CREATE TABLE IF NOT EXISTS readings (
  id          INTEGER PRIMARY KEY,
  device_id   TEXT NOT NULL,
  boot        INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  read_at     INTEGER NOT NULL,             -- received_at - ageS
  ret         INTEGER NOT NULL,
  fw          TEXT,
  verified    INTEGER NOT NULL,
  value_count INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS readings_dedupe ON readings(device_id, boot, seq) WHERE boot != 0;
CREATE INDEX IF NOT EXISTS readings_device_time ON readings(device_id, read_at);
CREATE TABLE IF NOT EXISTS reading_values (
  reading_id  INTEGER NOT NULL REFERENCES readings(id) ON DELETE CASCADE,
  obis        TEXT NOT NULL,
  name        TEXT NOT NULL,
  num         REAL,
  unit        TEXT NOT NULL,
  text        TEXT
);
CREATE INDEX IF NOT EXISTS reading_values_reading ON reading_values(reading_id, obis);
CREATE TABLE IF NOT EXISTS log_uploads (
  id          INTEGER PRIMARY KEY,
  device_id   TEXT NOT NULL,
  boot        INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  bytes       INTEGER NOT NULL,
  dropped     INTEGER NOT NULL,
  uptime_s    INTEGER NOT NULL,
  verified    INTEGER NOT NULL,
  file        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS log_uploads_dedupe ON log_uploads(device_id, boot, seq) WHERE boot != 0;
CREATE INDEX IF NOT EXISTS log_uploads_device_time ON log_uploads(device_id, received_at);
CREATE TABLE IF NOT EXISTS profile_columns (
  device_id   TEXT NOT NULL,
  obis        TEXT NOT NULL,
  name        TEXT NOT NULL,
  cols        TEXT NOT NULL,                -- JSON [{obis, name, unit}]
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (device_id, obis)
);
CREATE TABLE IF NOT EXISTS profile_rows (
  id          INTEGER PRIMARY KEY,
  device_id   TEXT NOT NULL,
  obis        TEXT NOT NULL,
  t           TEXT,                         -- row time, meter local "YYYY-MM-DD hh:mm:ss"
  cells       TEXT NOT NULL,                -- JSON array, one cell per column
  event       TEXT,
  row_key     TEXT NOT NULL,
  reading_id  INTEGER,
  received_at INTEGER NOT NULL,
  verified    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS profile_rows_dedupe ON profile_rows(device_id, obis, row_key);
CREATE INDEX IF NOT EXISTS profile_rows_time ON profile_rows(device_id, obis, t);
`;

const BILLING_OBIS = '1.0.98.1.0.255';
const CLOCK_OBIS = '0.0.1.0.0.255';
const OPEN_ROW_S = 3600;
const OPEN_ROW_KEY = 'open';

/** Meter local "YYYY-MM-DD hh:mm[:ss]" -> ms on a UTC scale (only differences matter), NaN if not a time. */
function localMs(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)(?::(\d\d|\*\*))?/.exec(String(s || ''));
  if (!m) return NaN;
  const sec = m[6] && m[6] !== '**' ? Number(m[6]) : 0;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), sec);
}

const isOpenTime = (t, clock) => Math.abs(localMs(t) - localMs(clock)) <= OPEN_ROW_S * 1000;

/** The open month's row of a billing profile in one reading (see the header), or null. */
function openBillingRow(p, clock) {
  if (p.obis !== BILLING_OBIS || !clock) return null;
  let newest = null;
  for (const r of p.rows) if (r.t && (!newest || r.t > newest.t)) newest = r;
  return newest && isOpenTime(newest.t, clock) ? newest : null;
}

function rowKey(row) {
  if (row.t && !row.e) return `t:${row.t}`;
  return 'h:' + crypto.createHash('sha256').update(`${row.t ?? ''}\n${JSON.stringify(row.c)}`).digest('hex').slice(0, 32);
}

/**
 * One-time data fixes, tracked in PRAGMA user_version.
 *   1: before the "open" key every cycle stored the open billing row again
 *      under its changing time. Of those copies (time within OPEN_ROW_S of the
 *      meter clock of the reading that stored them) the newest per device
 *      becomes the "open" row, the rest are deleted.
 *   2: devices.name (databases made before it).
 */
function migrate(db) {
  const version = db.pragma('user_version', { simple: true });
  if (version < 1) migrateOpenRows(db);
  if (version < 2) {
    const cols = db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name);
    if (!cols.includes('name')) db.exec('ALTER TABLE devices ADD COLUMN name TEXT');
    db.pragma('user_version = 2');
  }
}

function migrateOpenRows(db) {
  const rows = db.prepare(`
    SELECT r.id, r.device_id AS deviceId, r.t, v.text AS clock
    FROM profile_rows r JOIN reading_values v ON v.reading_id = r.reading_id AND v.obis = ?
    WHERE r.obis = ? AND r.row_key LIKE 't:%'
    ORDER BY r.device_id, r.t DESC`).all(CLOCK_OBIS, BILLING_OBIS);
  const hasOpen = db.prepare('SELECT 1 FROM profile_rows WHERE device_id = ? AND obis = ? AND row_key = ?');
  const toOpen = db.prepare('UPDATE profile_rows SET row_key = ? WHERE id = ?');
  const del = db.prepare('DELETE FROM profile_rows WHERE id = ?');
  db.transaction(() => {
    const kept = new Set();
    for (const r of rows) {
      if (!isOpenTime(r.t, r.clock)) continue;
      if (!kept.has(r.deviceId) && !hasOpen.get(r.deviceId, BILLING_OBIS, OPEN_ROW_KEY)) toOpen.run(OPEN_ROW_KEY, r.id);
      else del.run(r.id);
      kept.add(r.deviceId);
    }
    db.pragma('user_version = 1');
  })();
}

function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);

  const q = {
    touchDevice: db.prepare(`
      INSERT INTO devices (id, first_seen, last_seen, last_ip, fw, verified)
      VALUES (@id, @now, @now, @ip, @fw, @verified)
      ON CONFLICT(id) DO UPDATE SET last_seen = @now, last_ip = @ip,
        fw = COALESCE(@fw, fw), verified = @verified`),
    readingExists: db.prepare('SELECT 1 FROM readings WHERE device_id = ? AND boot = ? AND seq = ? AND boot != 0'),
    insertReading: db.prepare(`
      INSERT INTO readings (device_id, boot, seq, received_at, read_at, ret, fw, verified, value_count)
      VALUES (@deviceId, @boot, @seq, @receivedAt, @readAt, @ret, @fw, @verified, @count)`),
    insertValue: db.prepare(`
      INSERT INTO reading_values (reading_id, obis, name, num, unit, text)
      VALUES (@readingId, @obis, @name, @num, @unit, @text)`),
    setLastReading: db.prepare(`
      UPDATE devices SET last_reading_id = @id
      WHERE id = @deviceId AND (last_reading_id IS NULL OR
        (SELECT read_at FROM readings WHERE id = last_reading_id) <= @readAt)`),
    logExists: db.prepare('SELECT 1 FROM log_uploads WHERE device_id = ? AND boot = ? AND seq = ? AND boot != 0'),
    insertLog: db.prepare(`
      INSERT INTO log_uploads (device_id, boot, seq, received_at, bytes, dropped, uptime_s, verified, file)
      VALUES (@deviceId, @boot, @seq, @receivedAt, @bytes, @dropped, @uptimeS, @verified, @file)`),
    upsertColumns: db.prepare(`
      INSERT INTO profile_columns (device_id, obis, name, cols, updated_at)
      VALUES (@deviceId, @obis, @name, @cols, @now)
      ON CONFLICT(device_id, obis) DO UPDATE SET name = @name, cols = @cols, updated_at = @now`),
    profileRowExists: db.prepare('SELECT 1 FROM profile_rows WHERE device_id = ? AND obis = ? AND row_key = ?'),
    upsertProfileRow: db.prepare(`
      INSERT INTO profile_rows (device_id, obis, t, cells, event, row_key, reading_id, received_at, verified)
      VALUES (@deviceId, @obis, @t, @cells, @event, @rowKey, @readingId, @receivedAt, @verified)
      ON CONFLICT(device_id, obis, row_key) DO UPDATE SET t = @t, cells = @cells, event = @event,
        reading_id = @readingId, received_at = @receivedAt, verified = @verified
      WHERE cells != @cells OR t IS NOT @t`),
  };

  /**
   * Store a reading and its profile rows. Returns {stored, newRows}: stored is
   * false if the reading was a duplicate; newRows counts profile rows not seen before.
   */
  const saveReading = db.transaction((m) => {
    q.touchDevice.run({ id: m.deviceId, now: m.receivedAt, ip: m.ip, fw: m.fw ?? null, verified: m.verified ? 1 : 0 });
    if (q.readingExists.get(m.deviceId, m.boot, m.seq)) return { stored: false, newRows: 0 };
    const { lastInsertRowid } = q.insertReading.run({
      deviceId: m.deviceId, boot: m.boot, seq: m.seq, receivedAt: m.receivedAt, readAt: m.readAt,
      ret: m.ret, fw: m.fw ?? null, verified: m.verified ? 1 : 0, count: m.values.length,
    });
    for (const v of m.values) q.insertValue.run({ readingId: lastInsertRowid, ...v });
    q.setLastReading.run({ id: lastInsertRowid, deviceId: m.deviceId, readAt: m.readAt });
    let newRows = 0;
    const clock = m.values.find((v) => v.obis === CLOCK_OBIS)?.text;
    for (const p of m.profiles || []) {
      q.upsertColumns.run({ deviceId: m.deviceId, obis: p.obis, name: p.name, cols: JSON.stringify(p.cols), now: m.receivedAt });
      const open = openBillingRow(p, clock);
      for (const r of p.rows) {
        const key = r === open ? OPEN_ROW_KEY : rowKey(r);
        if (!q.profileRowExists.get(m.deviceId, p.obis, key)) newRows++;
        q.upsertProfileRow.run({
          deviceId: m.deviceId, obis: p.obis, t: r.t, cells: JSON.stringify(r.c), event: r.e,
          rowKey: key, readingId: lastInsertRowid, receivedAt: m.receivedAt, verified: m.verified ? 1 : 0,
        });
      }
    }
    return { stored: true, newRows };
  });

  /** True if this log upload was stored before (a resend). */
  function isDuplicateLog(deviceId, boot, seq) {
    return !!q.logExists.get(deviceId, boot, seq);
  }

  const saveLog = db.transaction((m) => {
    q.touchDevice.run({ id: m.deviceId, now: m.receivedAt, ip: m.ip, fw: null, verified: m.verified ? 1 : 0 });
    q.insertLog.run(m);
  });

  /** Record that a device was seen, e.g. for a duplicate that is not stored again. */
  function touchDevice(deviceId, now, ip, verified) {
    q.touchDevice.run({ id: deviceId, now, ip, fw: null, verified: verified ? 1 : 0 });
  }

  // ── Queries for the REST API ─────────────────────────────────────────────
  const listDevicesStmt = db.prepare(`
    SELECT d.id, d.name, d.first_seen AS firstSeen, d.last_seen AS lastSeen, d.last_ip AS lastIp, d.fw,
           d.verified, r.read_at AS lastReadAt, r.ret AS lastRet, r.value_count AS lastValueCount,
           (SELECT MAX(received_at) FROM log_uploads l WHERE l.device_id = d.id) AS lastLogAt
    FROM devices d LEFT JOIN readings r ON r.id = d.last_reading_id
    ORDER BY d.last_seen DESC`);
  const deviceStmt = db.prepare('SELECT id, last_reading_id AS lastReadingId FROM devices WHERE id = ?');
  const setNameStmt = db.prepare('UPDATE devices SET name = ? WHERE id = ?');
  const readingStmt = db.prepare(`
    SELECT id, device_id AS deviceId, boot, seq, received_at AS receivedAt, read_at AS readAt, ret, fw,
           verified, value_count AS valueCount
    FROM readings WHERE id = ?`);
  const valuesStmt = db.prepare(`
    SELECT obis, name, num, unit, text FROM reading_values WHERE reading_id = ? ORDER BY rowid`);
  const readingsStmt = db.prepare(`
    SELECT id, read_at AS readAt, received_at AS receivedAt, ret, fw, verified, value_count AS valueCount
    FROM readings WHERE device_id = @deviceId AND read_at BETWEEN @from AND @to
    ORDER BY read_at DESC LIMIT @limit`);
  const historyStmt = db.prepare(`
    SELECT r.read_at AS readAt, v.num, v.unit, v.text, v.name, r.verified
    FROM readings r JOIN reading_values v ON v.reading_id = r.id
    WHERE r.device_id = @deviceId AND v.obis = @obis AND r.read_at BETWEEN @from AND @to
    ORDER BY r.read_at DESC LIMIT @limit`);

  const profileListStmt = db.prepare(`
    SELECT c.obis, c.name, c.cols, c.updated_at AS updatedAt,
           (SELECT COUNT(*) FROM profile_rows r WHERE r.device_id = c.device_id AND r.obis = c.obis) AS rowCount,
           (SELECT MAX(t) FROM profile_rows r WHERE r.device_id = c.device_id AND r.obis = c.obis) AS lastT
    FROM profile_columns c WHERE c.device_id = ? ORDER BY c.obis`);
  const profileColsStmt = db.prepare('SELECT name, cols FROM profile_columns WHERE device_id = ? AND obis = ?');
  // Rows without a time (name plate) sort last; from/to only match timed rows.
  const profileRowsStmt = db.prepare(`
    SELECT t, cells, event, received_at AS receivedAt, verified FROM profile_rows
    WHERE device_id = @deviceId AND obis = @obis
      AND (@from IS NULL OR t >= @from) AND (@to IS NULL OR t <= @to)
    ORDER BY t IS NULL, t DESC, id DESC LIMIT @limit`);

  function profiles(deviceId) {
    return profileListStmt.all(deviceId).map((p) => ({ ...p, cols: JSON.parse(p.cols) }));
  }

  /** One profile's columns and rows (newest first), or null if the device never sent it. */
  function profileRows({ deviceId, obis, from = null, to = null, limit }) {
    const c = profileColsStmt.get(deviceId, obis);
    if (!c) return null;
    const rows = profileRowsStmt.all({ deviceId, obis, from, to, limit })
      .map((r) => ({ t: r.t, c: JSON.parse(r.cells), e: r.event, receivedAt: r.receivedAt, verified: r.verified }));
    return { obis, name: c.name, cols: JSON.parse(c.cols), rows };
  }

  // ── Queries for the overview pages ───────────────────────────────────────
  // Values of each device's newest reading that has values (a failed cycle
  // may carry none), limited to the given OBIS codes.
  const summaryValuesStmt = db.prepare(`
    SELECT d.id AS deviceId, v.obis, v.num, v.unit, v.text
    FROM devices d JOIN reading_values v ON v.reading_id = (
      SELECT r.id FROM readings r WHERE r.device_id = d.id AND r.value_count > 0 ORDER BY r.read_at DESC LIMIT 1)
    WHERE v.obis IN (SELECT value FROM json_each(?))`);
  const readingHoursStmt = db.prepare(`
    SELECT CAST((received_at - @from) / 3600000 AS INTEGER) AS h, COUNT(*) AS n, SUM(ret != 0) AS failed
    FROM readings WHERE received_at >= @from AND received_at < @to GROUP BY h`);
  const logHoursStmt = db.prepare(`
    SELECT CAST((received_at - @from) / 3600000 AS INTEGER) AS h, COUNT(*) AS n
    FROM log_uploads WHERE received_at >= @from AND received_at < @to GROUP BY h`);
  const lastMessageStmt = db.prepare('SELECT id, name, last_seen AS at FROM devices ORDER BY last_seen DESC LIMIT 1');
  const readingDaysStmt = db.prepare(`
    SELECT CAST((read_at - @from) / 86400000 AS INTEGER) AS d, COUNT(*) AS n, SUM(ret != 0) AS failed, COUNT(DISTINCT boot) AS boots
    FROM readings WHERE device_id = @deviceId AND read_at >= @from GROUP BY d`);
  const readingTotalsStmt = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(ret != 0), 0) AS failed, COUNT(DISTINCT boot) AS boots,
           AVG(received_at - read_at) AS avgDelayMs
    FROM readings WHERE device_id = @deviceId AND read_at >= @from`);
  const logTotalsStmt = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(dropped), 0) AS dropped
    FROM log_uploads WHERE device_id = @deviceId AND received_at >= @from`);
  const lastLogStmt = db.prepare(`
    SELECT received_at AS at, uptime_s AS uptimeS, boot, verified FROM log_uploads
    WHERE device_id = ? ORDER BY received_at DESC LIMIT 1`);

  /** Readings and log uploads per hour in [from, to), one entry per hour. */
  function activity(from, to) {
    const hours = Array.from({ length: Math.ceil((to - from) / 3600000) }, () => ({ readings: 0, failed: 0, logs: 0 }));
    for (const r of readingHoursStmt.all({ from, to })) Object.assign(hours[r.h], { readings: r.n, failed: r.failed });
    for (const r of logHoursStmt.all({ from, to })) hours[r.h].logs = r.n;
    return hours;
  }

  /** One device's message counts since `from`, readings also per day (days from `from`). */
  function deviceStats(deviceId, from, days) {
    const perDay = Array.from({ length: days }, () => ({ readings: 0, failed: 0 }));
    for (const r of readingDaysStmt.all({ deviceId, from })) {
      if (r.d < days) Object.assign(perDay[r.d], { readings: r.n, failed: r.failed });
    }
    return {
      readings: readingTotalsStmt.get({ deviceId, from }),
      logs: logTotalsStmt.get({ deviceId, from }),
      lastLog: lastLogStmt.get(deviceId) || null,
      perDay,
    };
  }

  function latestReading(deviceId) {
    const d = deviceStmt.get(deviceId);
    if (!d) return undefined;
    if (!d.lastReadingId) return null;
    const r = readingStmt.get(d.lastReadingId);
    r.values = valuesStmt.all(r.id);
    return r;
  }

  // ── Retention ────────────────────────────────────────────────────────────
  const pruneReadingsStmt = db.prepare('DELETE FROM readings WHERE read_at < ?');
  const pruneLogsStmt = db.prepare('DELETE FROM log_uploads WHERE received_at < ?');
  const pruneProfileRowsStmt = db.prepare('DELETE FROM profile_rows WHERE received_at < ?');
  const fixLastStmt = db.prepare(`
    UPDATE devices SET last_reading_id =
      (SELECT id FROM readings r WHERE r.device_id = devices.id ORDER BY read_at DESC LIMIT 1)
    WHERE last_reading_id NOT IN (SELECT id FROM readings)`);
  const prune = db.transaction((before) => {
    const n = pruneReadingsStmt.run(before).changes;
    pruneLogsStmt.run(before);
    pruneProfileRowsStmt.run(before);
    fixLastStmt.run();
    return n;
  });

  // ── Delete ───────────────────────────────────────────────────────────────
  // A device that still sends is created again, empty, by its next message.
  const deleteStmts = {
    readings: db.prepare('DELETE FROM readings WHERE device_id = ?'),   // reading_values cascade
    profileRows: db.prepare('DELETE FROM profile_rows WHERE device_id = ?'),
    profileColumns: db.prepare('DELETE FROM profile_columns WHERE device_id = ?'),
    logUploads: db.prepare('DELETE FROM log_uploads WHERE device_id = ?'),
    devices: db.prepare('DELETE FROM devices WHERE id = ?'),
  };
  /** Remove a device and everything stored for it. Returns rows removed per table. */
  const deleteDevice = db.transaction((id) => Object.fromEntries(
    Object.entries(deleteStmts).map(([k, stmt]) => [k, stmt.run(id).changes])));

  return {
    db,
    saveReading,
    saveLog,
    isDuplicateLog,
    touchDevice,
    listDevices: () => listDevicesStmt.all(),
    hasDevice: (id) => !!deviceStmt.get(id),
    setName: (id, name) => setNameStmt.run(name, id).changes === 1,
    latestReading,
    readings: (p) => readingsStmt.all(p),
    history: (p) => historyStmt.all(p),
    profiles,
    profileRows,
    summaryValues: (obisList) => summaryValuesStmt.all(JSON.stringify(obisList)),
    activity,
    lastMessage: () => lastMessageStmt.get() || null,
    deviceStats,
    prune,
    deleteDevice,
    close: () => db.close(),
  };
}

module.exports = { openDb };
