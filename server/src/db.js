'use strict';
// =============================================================================
//  db.js  --  SQLite storage (better-sqlite3, synchronous)
//
//  Duplicates (a message resent after a lost SEND OK) are dropped by
//  (device_id, boot, seq). boot 0 means "no boot id" (2.0.0 log bridge):
//  those are never treated as duplicates because seq restarts at each boot.
// =============================================================================
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  last_ip     TEXT,
  fw          TEXT,
  verified    INTEGER NOT NULL DEFAULT 0,   -- last message was signed and checked
  last_reading_id INTEGER
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
`;

function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

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
  };

  /** Store a reading. Returns false if it was a duplicate. */
  const saveReading = db.transaction((m) => {
    q.touchDevice.run({ id: m.deviceId, now: m.receivedAt, ip: m.ip, fw: m.fw ?? null, verified: m.verified ? 1 : 0 });
    if (q.readingExists.get(m.deviceId, m.boot, m.seq)) return false;
    const { lastInsertRowid } = q.insertReading.run({
      deviceId: m.deviceId, boot: m.boot, seq: m.seq, receivedAt: m.receivedAt, readAt: m.readAt,
      ret: m.ret, fw: m.fw ?? null, verified: m.verified ? 1 : 0, count: m.values.length,
    });
    for (const v of m.values) q.insertValue.run({ readingId: lastInsertRowid, ...v });
    q.setLastReading.run({ id: lastInsertRowid, deviceId: m.deviceId, readAt: m.readAt });
    return true;
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
    SELECT d.id, d.first_seen AS firstSeen, d.last_seen AS lastSeen, d.last_ip AS lastIp, d.fw,
           d.verified, r.read_at AS lastReadAt, r.ret AS lastRet, r.value_count AS lastValueCount,
           (SELECT MAX(received_at) FROM log_uploads l WHERE l.device_id = d.id) AS lastLogAt
    FROM devices d LEFT JOIN readings r ON r.id = d.last_reading_id
    ORDER BY d.last_seen DESC`);
  const deviceStmt = db.prepare('SELECT id, last_reading_id AS lastReadingId FROM devices WHERE id = ?');
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
  const fixLastStmt = db.prepare(`
    UPDATE devices SET last_reading_id =
      (SELECT id FROM readings r WHERE r.device_id = devices.id ORDER BY read_at DESC LIMIT 1)
    WHERE last_reading_id NOT IN (SELECT id FROM readings)`);
  const prune = db.transaction((before) => {
    const n = pruneReadingsStmt.run(before).changes;
    pruneLogsStmt.run(before);
    fixLastStmt.run();
    return n;
  });

  return {
    db,
    saveReading,
    saveLog,
    isDuplicateLog,
    touchDevice,
    listDevices: () => listDevicesStmt.all(),
    hasDevice: (id) => !!deviceStmt.get(id),
    latestReading,
    readings: (p) => readingsStmt.all(p),
    history: (p) => historyStmt.all(p),
    prune,
    close: () => db.close(),
  };
}

module.exports = { openDb };
