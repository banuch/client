'use strict';
// =============================================================================
//  http-server.js  --  REST API + web page (public/)
//
//    GET /api/health                                   no login
//    GET /api/devices                                  all devices, newest first
//    GET /api/devices/:id/latest                       latest reading with values
//    GET /api/devices/:id/readings?from=&to=&limit=    reading list (no values)
//    GET /api/devices/:id/readings?obis=&from=&to=&limit=   one value over time
//    GET /api/devices/:id/log-dates                    days that have a log file
//    GET /api/devices/:id/logs?date=YYYY-MM-DD&tail=N  end of one day's log (text)
//
//  from / to: epoch milliseconds or an ISO date. Times in replies are epoch ms.
//
//  Login: HTTP Basic with VIEW_USER / VIEW_PASSWORD. Without a password the
//  page has no login and config.js binds it to 127.0.0.1 only. After
//  LOGIN_MAX_FAILS wrong passwords an IP is locked out for LOGIN_LOCK_SEC.
// =============================================================================
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const OBIS = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

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
    const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(req.get('authorization') || '');
    if (m) {
      const text = Buffer.from(m[1], 'base64').toString('utf8');
      const colon = text.indexOf(':');
      const user = colon === -1 ? text : text.slice(0, colon);
      const pass = colon === -1 ? '' : text.slice(colon + 1);
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

  // ── API ──────────────────────────────────────────────────────────────────
  const api = express.Router();

  api.get('/devices', (req, res) => res.json(db.listDevices()));

  api.param('id', (req, res, next, id) => {
    if (!DEVICE_ID.test(id) || !db.hasDevice(id)) return res.status(404).json({ error: 'unknown_device' });
    next();
  });

  api.get('/devices/:id/latest', (req, res) => {
    res.json(db.latestReading(req.params.id));
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
