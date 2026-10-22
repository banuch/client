'use strict';
// =============================================================================
//  config.js  --  runtime configuration from environment / .env
//
//  Tiny .env loader (KEY=VALUE lines, # comments) so the server has no
//  dotenv dependency. Real environment variables win over .env values.
// =============================================================================
const fs = require('fs');
const path = require('path');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

function bool(v, dflt) {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}

function loadConfig(overrides = {}) {
  loadDotEnv(path.join(__dirname, '..', '.env'));
  const env = process.env;
  const dataDir = overrides.dataDir || env.DATA_DIR || path.join(__dirname, '..', 'data');
  const cfg = {
    // Device port (TCP, header line + body, see framing.js)
    tcpHost: env.TCP_HOST || '0.0.0.0',
    tcpPort: Number(env.TCP_PORT || 5100),
    // Web page + REST API
    httpHost: env.HTTP_HOST || '0.0.0.0',
    httpPort: Number(env.HTTP_PORT || 5101),
    viewUser: env.VIEW_USER || 'admin',
    viewPassword: env.VIEW_PASSWORD || '',
    // Same MASTER_SECRET as the OTA server: device key = HMAC(MASTER_SECRET, IMEI)
    masterSecret: env.MASTER_SECRET || '',
    requireSigned: bool(env.REQUIRE_SIGNED, false),
    dataDir,
    dbFile: path.join(dataDir, 'amr-data.db'),
    logDir: path.join(dataDir, 'logs'),
    // Day boundaries of the log files and times on the page
    timezone: env.TIMEZONE || 'Asia/Kolkata',
    retentionDays: Number(env.RETENTION_DAYS || 0), // 0 = keep everything
    // Limits
    maxHeaderBytes: Number(env.MAX_HEADER_BYTES || 4096),
    maxReadingBytes: Number(env.MAX_READING_BYTES || 256 * 1024),
    maxLogBytes: Number(env.MAX_LOG_BYTES || 1024 * 1024),
    maxConnections: Number(env.MAX_CONNECTIONS || 200),
    idleTimeoutSec: Number(env.IDLE_TIMEOUT_SEC || 120),
    loginMaxFails: Number(env.LOGIN_MAX_FAILS || 10),
    loginLockSec: Number(env.LOGIN_LOCK_SEC || 15 * 60),
    clock: Date.now,
    ...overrides,
  };
  // Without a password the page is only reachable from the server itself.
  if (!cfg.viewPassword && !('httpHost' in overrides)) cfg.httpHost = '127.0.0.1';
  return cfg;
}

function assertConfig(cfg) {
  const problems = [];
  if (cfg.viewPassword && cfg.viewPassword.length < 10) problems.push('VIEW_PASSWORD must be at least 10 characters');
  if (cfg.requireSigned && cfg.masterSecret.length < 16) {
    problems.push('REQUIRE_SIGNED=true needs MASTER_SECRET (the OTA server\'s, at least 16 characters)');
  }
  if (cfg.masterSecret && cfg.masterSecret.length < 16) problems.push('MASTER_SECRET must be at least 16 characters');
  if (problems.length) {
    throw new Error('Invalid configuration:\n  - ' + problems.join('\n  - ') +
      '\nCopy .env.example to .env and fill it in.');
  }
}

module.exports = { loadConfig, assertConfig };
