'use strict';
// =============================================================================
//  server.js  --  entry point: device TCP port + web page / REST API
// =============================================================================
const fs = require('fs');
const { loadConfig, assertConfig } = require('./config');
const { openDb } = require('./db');
const { createLogStore } = require('./log-store');
const { createTcpServer } = require('./tcp-server');
const { createHttpApp } = require('./http-server');

/** Build and start both servers. Resolves to {tcpPort, httpPort, stop()}. */
async function start(overrides = {}, { log = console.log } = {}) {
  const cfg = loadConfig(overrides);
  assertConfig(cfg);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const db = openDb(cfg.dbFile);
  const logs = createLogStore(cfg);

  const tcp = createTcpServer(cfg, { db, logs, log });
  const app = createHttpApp(cfg, { db, logs });

  await new Promise((resolve, reject) => {
    tcp.once('error', reject);
    tcp.listen(cfg.tcpPort, cfg.tcpHost, resolve);
  });
  const http = await new Promise((resolve, reject) => {
    const s = app.listen(cfg.httpPort, cfg.httpHost, () => resolve(s));
    s.once('error', reject);
  });

  let pruneTimer = null;
  if (cfg.retentionDays > 0) {
    const prune = () => {
      const before = cfg.clock() - cfg.retentionDays * 86400 * 1000;
      const n = db.prune(before);
      const f = logs.prune(before);
      if (n || f) log(`[DATA] retention: removed ${n} readings, ${f} log files`);
    };
    prune();
    pruneTimer = setInterval(prune, 3600 * 1000);
    pruneTimer.unref();
  }

  const tcpPort = tcp.address().port;
  const httpPort = http.address().port;
  log(`[DATA] device port ${cfg.tcpHost}:${tcpPort}`);
  log(`[DATA] web page  http://${cfg.httpHost}:${httpPort}/` +
    (cfg.viewPassword ? ` (user ${cfg.viewUser})` : ' (no VIEW_PASSWORD: local only)'));
  if (!cfg.masterSecret) log('[DATA] MASTER_SECRET not set: signatures are not checked, all data is "unverified"');
  else if (!cfg.requireSigned) log('[DATA] unsigned data is accepted and marked unverified (REQUIRE_SIGNED=false)');

  async function stop() {
    if (pruneTimer) clearInterval(pruneTimer);
    const tcpClosed = new Promise((r) => tcp.close(r));
    tcp.destroyAll();
    await tcpClosed;
    http.closeAllConnections?.();
    await new Promise((r) => http.close(r));
    db.close();
  }
  return { tcpPort, httpPort, stop, cfg };
}

if (require.main === module) {
  start().then((s) => {
    const shutdown = () => s.stop().then(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { start };
