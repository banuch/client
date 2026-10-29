'use strict';
// =============================================================================
//  http-server.js  --  REST API + web page (public/)
//
//    GET /api/health                                   no login
//    GET /api/config                                   status thresholds, time zone, server time
//    GET /api/fleet                                    status counts, activity today, needs attention
//    GET /api/meters                                   every device with status, issues, key values
//    GET /api/devices                                  all devices, newest first
//    GET /api/devices/:id/stats?days=7                 message counts (per day) and log totals
//    GET /api/devices/:id/latest                       latest reading with values
//    GET /api/devices/:id/readings?from=&to=&limit=    reading list (no values)
//    GET /api/devices/:id/readings?obis=&from=&to=&limit=   one value over time
//    GET /api/devices/:id/profiles                     profiles the device sent (columns, row count)
//    GET /api/devices/:id/profiles/:obis?from=&to=&limit=   rows of one profile, newest first
//    GET /api/devices/:id/log-dates                    days that have a log file
//    GET /api/devices/:id/logs?date=YYYY-MM-DD&tail=N  end of one day's log (text)
//
//  from / to: epoch milliseconds or an ISO date. Times in replies are epoch ms.
//  Profile rows are the exception: their time t is the meter's local time as
//  text, and from / to filter on it ("YYYY-MM-DD" or "YYYY-MM-DD hh:mm[:ss]").
//
//  Login: HTTP Basic with VIEW_USER / VIEW_PASSWORD. Without a password the
//  page has no login and config.js binds it to 127.0.0.1 only. After
//  LOGIN_MAX_FAILS wrong passwords an IP is locked out for LOGIN_LOCK_SEC.
//  GET /logout (no login) is used by the page's Log out button, see below.
// =============================================================================
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { SUMMARY_OBIS, buildMeters, countStatuses, attention, byFirmware, dayStart } = require('./meters');

const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const OBIS = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const ROW_TIME = /^\d{4}-\d\d-\d\d( \d\d:\d\d(:\d\d)?)?$/;
const LOGOUT_USER = 'signed-out';

/** A profile row time bound, null if absent, undefined if malformed. A bare date as "to" includes that day. */
function parseRowTime(v, isTo) {
  if (v === undefined || v === '') return null;
  const s = String(v);
  if (!ROW_TIME.test(s)) return undefined;
  if (s.length === 10) return isTo ? `${s} 23:59:59` : `${s} 00:00:00`;
  return s.length === 16 ? `${s}:${isTo ? '59' : '00'}` : s;
}

function safeEqual(a, b) {
  // Hash first so the compare does not leak the length.
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseTime(v, dflt) {
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
}

function createHttpApp(cfg, { db, logs }) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  // ── Login ────────────────────────────────────────────────────────────────
  // Log out: the page sends LOGOUT_USER to /logout, which accepts it, so the
  // browser stores that login in place of the real one. Afterwards the
  // browser sends LOGOUT_USER everywhere, which is treated as "not signed in".
  const basicUser = (req) => {
    const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(req.get('authorization') || '');
    if (!m) return null;
    const text = Buffer.from(m[1], 'base64').toString('utf8');
    const colon = text.indexOf(':');
    return colon === -1 ? { user: text, pass: '' } : { user: text.slice(0, colon), pass: text.slice(colon + 1) };
  };
  app.get('/logout', (req, res) => {
    if (basicUser(req)?.user === LOGOUT_USER) return res.status(204).end();
    res.set('WWW-Authenticate', 'Basic realm="AMR data", charset="UTF-8"');
    return res.status(401).json({ error: 'login_required' });
  });

  const fails = new Map();   // ip -> {count, until}
  app.use((req, res, next) => {
    if (!cfg.viewPassword) return next();
    const now = cfg.clock();
    const ip = req.ip;
    const f = fails.get(ip);
    if (f && f.until > now) {
      res.set('Retry-After', String(Math.ceil((f.until - now) / 1000)));
      return res.status(429).json({ error: 'too_many_failed_logins' });
    }
    const login = basicUser(req);
    if (login && login.user !== LOGOUT_USER) {
      const { user, pass } = login;
      const ok = safeEqual(user, cfg.viewUser) & safeEqual(pass, cfg.viewPassword);
      if (ok) {
        fails.delete(ip);
        return next();
      }
      let count = f ? f.count : 0;
      if (f && f.until && f.until <= now) count = 0;   // previous lock has expired
      count++;
      fails.set(ip, { count, until: count >= cfg.loginMaxFails ? now + cfg.loginLockSec * 1000 : 0 });
      if (fails.size > 10000) fails.clear();
    }
    res.set('WWW-Authenticate', 'Basic realm="AMR data", charset="UTF-8"');
    return res.status(401).json({ error: 'login_required' });
  });

  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));
  // Chart library from node_modules: the CSP allows scripts from this server only.
  const chartFile = path.join(path.dirname(require.resolve('chart.js')), 'chart.umd.js');
  app.get('/vendor/chart.js', (req, res) => res.sendFile(chartFile));

  // ── API ──────────────────────────────────────────────────────────────────
  const api = express.Router();

  const meterList = (now) => buildMeters(db.listDevices(), db.summaryValues(Object.values(SUMMARY_OBIS)), now, cfg);

  api.get('/config', (req, res) => res.json({
    timezone: cfg.timezone,
    onlineAfterMin: cfg.onlineAfterMin,
    offlineAfterMin: cfg.offlineAfterMin,
    signing: cfg.masterSecret ? (cfg.requireSigned ? 'required' : 'checked') : 'off',
    login: Boolean(cfg.viewPassword),
    now: cfg.clock(),
  }));

  api.get('/meters', (req, res) => {
    const now = cfg.clock();
    const meters = meterList(now);
    res.json({ now, counts: countStatuses(meters), meters });
  });

  api.get('/fleet', (req, res) => {
    const now = cfg.clock();
    const meters = meterList(now);
    const from = dayStart(now, cfg.timezone);
    const hours = db.activity(from, from + 24 * 3600 * 1000);
    res.json({
      now,
      dayStart: from,
      counts: countStatuses(meters),
      hours,
      readingsToday: hours.reduce((n, h) => n + h.readings, 0),
      failedToday: hours.reduce((n, h) => n + h.failed, 0),
      logsToday: hours.reduce((n, h) => n + h.logs, 0),
      lastMessage: db.lastMessage(),
      attention: attention(meters),
      byFirmware: byFirmware(meters),
    });
  });

  api.get('/devices', (req, res) => res.json(db.listDevices()));

  api.param('id', (req, res, next, id) => {
    if (!DEVICE_ID.test(id) || !db.hasDevice(id)) return res.status(404).json({ error: 'unknown_device' });
    next();
  });

  api.get('/devices/:id/latest', (req, res) => {
    res.json(db.latestReading(req.params.id));
  });

  // Per-day buckets start at midnight in cfg.timezone, `days` days back including today.
  api.get('/devices/:id/stats', (req, res) => {
    const now = cfg.clock();
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 31);
    const from = dayStart(now, cfg.timezone) - (days - 1) * 86400 * 1000;
    res.json({ now, from, days, ...db.deviceStats(req.params.id, from, days) });
  });

  api.get('/devices/:id/readings', (req, res) => {
    const now = cfg.clock();
    const from = parseTime(req.query.from, now - 7 * 86400 * 1000);
    const to = parseTime(req.query.to, now + 60 * 1000);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 5000);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return res.status(400).json({ error: 'bad_time' });
    const p = { deviceId: req.params.id, from, to, limit };
    if (req.query.obis !== undefined) {
      if (!OBIS.test(String(req.query.obis))) return res.status(400).json({ error: 'bad_obis' });
      return res.json(db.history({ ...p, obis: String(req.query.obis) }));
    }
    res.json(db.readings(p));
  });

  api.get('/devices/:id/profiles', (req, res) => res.json(db.profiles(req.params.id)));

  api.get('/devices/:id/profiles/:obis', (req, res) => {
    if (!OBIS.test(req.params.obis)) return res.status(400).json({ error: 'bad_obis' });
    const from = parseRowTime(req.query.from, false);
    const to = parseRowTime(req.query.to, true);
    if (from === undefined || to === undefined) return res.status(400).json({ error: 'bad_time' });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 5000);
    const p = db.profileRows({ deviceId: req.params.id, obis: req.params.obis, from, to, limit });
    if (!p) return res.status(404).json({ error: 'unknown_profile' });
    res.json(p);
  });

  api.get('/devices/:id/log-dates', (req, res) => res.json(logs.dates(req.params.id)));

  api.get('/devices/:id/logs', (req, res) => {
    const date = String(req.query.date || logs.today(cfg.clock()));
    const bytes = Math.min(Math.max(parseInt(req.query.tail, 10) || 64 * 1024, 1024), 1024 * 1024);
    const t = logs.tail(req.params.id, date, bytes);
    if (!t) return res.status(404).json({ error: 'no_log_for_date' });
    res.set('X-Log-Size', String(t.size));
    res.set('X-Log-Truncated', t.truncated ? '1' : '0');
    res.type('text/plain; charset=utf-8').send(t.text);
  });

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[HTTP]', err);
    res.status(500).json({ error: 'internal_error' });
  });
  return app;
}

module.exports = { createHttpApp };
