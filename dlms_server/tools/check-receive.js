#!/usr/bin/env node
'use strict';
// =============================================================================
//  check-receive.js  --  is the data server receiving packets?
//
//    node tools/check-receive.js [options]
//
//    --host <addr>      server address            (default 127.0.0.1)
//    --port <n>         device TCP port           (default TCP_PORT or 7001)
//    --http <n>         web/API port              (default HTTP_PORT or 7002)
//    --user <name>      page login                (default VIEW_USER or admin)
//    --pass <password>  page login                (default VIEW_PASSWORD)
//    --device <id>      device id to send as      (default TEST-CHECK)
//    --secret <s>       MASTER_SECRET to sign with (default MASTER_SECRET; "" = unsigned)
//    --no-api           only check the TCP side
//
//  Steps, each PASS or FAIL:
//    1. TCP connect to the device port
//    2. send one READING + one LOG, as the firmware does
//    3. the server replies ok to both
//    4. (API) the reading is stored: latest values contain this run's marker
//    5. (API) the log is stored: today's log contains the marker
//
//  Exit code 0 when every step passed, 1 otherwise. Defaults come from the
//  environment / .env, so on the server itself no options are needed.
// =============================================================================
const net = require('net');
const crypto = require('crypto');
const { loadConfig } = require('../src/config');
const { deviceKey } = require('../src/verify');
const { buildMessage } = require('../src/message');

const STEP_TIMEOUT_MS = 10000;

function parseArgs(argv, cfg) {
  const o = {
    host: '127.0.0.1', port: cfg.tcpPort, http: cfg.httpPort, user: cfg.viewUser, pass: cfg.viewPassword,
    device: 'TEST-CHECK', secret: cfg.masterSecret, api: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--host') o.host = next();
    else if (a === '--port') o.port = Number(next());
    else if (a === '--http') o.http = Number(next());
    else if (a === '--user') o.user = next();
    else if (a === '--pass') o.pass = next();
    else if (a === '--device') o.device = next();
    else if (a === '--secret') o.secret = next();
    else if (a === '--no-api') o.api = false;
    else if (a === '-h' || a === '--help') {
      console.log(require('fs').readFileSync(__filename, 'utf8').split('\n').slice(3, 26).join('\n'));
      process.exit(0);
    } else throw new Error(`unknown option ${a} (try --help)`);
  }
  return o;
}

let failed = 0;
function result(ok, step, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` -- ${detail}` : ''}`);
  return ok;
}

/** Connect, send, collect `count` reply lines. */
function exchange(o, data, count) {
  return new Promise((resolve) => {
    const out = { connected: false, replies: [], error: null };
    const sock = net.connect(o.port, o.host);
    const timer = setTimeout(() => {
      out.error = out.connected ? 'no reply within 10 s' : 'connect timed out (firewall? wrong port?)';
      sock.destroy();
    }, STEP_TIMEOUT_MS);
    let buf = '';
    sock.on('connect', () => {
      out.connected = true;
      sock.write(data);
    });
    sock.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n').filter(Boolean);
      if (lines.length >= count) sock.end();
    });
    sock.on('error', (e) => {
      out.error = e.code === 'ECONNREFUSED' ? 'connection refused (server not running on this port?)' : e.message;
    });
    sock.on('close', () => {
      clearTimeout(timer);
      for (const l of buf.split('\n').filter(Boolean)) {
        try {
          out.replies.push(JSON.parse(l));
        } catch {
          out.replies.push({ raw: l });
        }
      }
      resolve(out);
    });
  });
}

async function api(o, path, text = false) {
  const headers = {};
  if (o.pass) headers.Authorization = 'Basic ' + Buffer.from(`${o.user}:${o.pass}`).toString('base64');
  const res = await fetch(`http://${o.host}:${o.http}${path}`, { headers, signal: AbortSignal.timeout(STEP_TIMEOUT_MS) });
  if (res.status === 401) throw new Error('HTTP 401: wrong --user / --pass');
  if (res.status === 429) throw new Error('HTTP 429: login locked after failed attempts, wait and retry');
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return text ? res.text() : res.json();
}

async function main() {
  const cfg = loadConfig();
  const o = parseArgs(process.argv.slice(2), cfg);
  const key = o.secret ? deviceKey(o.secret, o.device) : undefined;
  const marker = `check-${crypto.randomBytes(4).toString('hex')}`;
  const boot = crypto.randomInt(1, 0xffffffff);

  console.log(`Data server ${o.host}:${o.port} (API ${o.api ? `${o.host}:${o.http}` : 'skipped'})`);
  console.log(`Sending as ${o.device}, ${key ? 'signed' : 'unsigned'}, marker ${marker}\n`);

  const reading = {
    ret: 0,
    values: [
      { obis: '0.0.96.1.0.255', name: 'Receive check marker', s: marker },
      { obis: '1.0.32.7.0.255', name: 'Voltage R', v: 230.5, u: 'V' },
    ],
  };
  const data = Buffer.concat([
    buildMessage({ type: 'READING', deviceId: o.device, boot, seq: 0, fw: 'check', ageS: 0, body: JSON.stringify(reading), key }),
    buildMessage({ type: 'LOG', deviceId: o.device, boot, seq: 0, dropped: 0, uptimeS: 0,
      body: `receive check ${marker} at ${new Date().toISOString()}\r\n`, key }),
  ]);

  const t0 = Date.now();
  const r = await exchange(o, data, 2);
  result(r.connected, '1. TCP connect', r.connected ? `${o.host}:${o.port}` : r.error);
  if (!r.connected) return;
  result(true, '2. send READING + LOG', `${data.length} bytes`);
  const [rr, lr] = r.replies;
  const replyOk = rr && rr.ok && rr.type === 'READING' && lr && lr.ok && lr.type === 'LOG';
  const why = r.replies.find((x) => !x.ok)?.error || r.error || 'missing reply';
  result(replyOk, '3. server replies', replyOk ? `ok to both in ${Date.now() - t0} ms` : `${why} ${JSON.stringify(r.replies)}`);
  if (!replyOk) {
    if (why === 'bad_signature') console.log('      --secret does not match the server\'s MASTER_SECRET');
    if (why === 'signature_required') console.log('      server has REQUIRE_SIGNED=true: pass --secret <MASTER_SECRET>');
    return;
  }
  if (!o.api) return;

  const id = encodeURIComponent(o.device);
  try {
    const latest = await api(o, `/api/devices/${id}/latest`);
    const found = latest && latest.values.some((v) => v.text === marker);
    result(!!found, '4. reading stored', found
      ? `${latest.valueCount} values, ${latest.verified ? 'verified' : 'unverified'}`
      : 'latest reading does not contain the marker');
  } catch (e) {
    result(false, '4. reading stored', e.cause?.code === 'ECONNREFUSED' || e.name === 'TimeoutError'
      ? `API not reachable on ${o.host}:${o.http} (no VIEW_PASSWORD = local only; firewall?)`
      : e.message);
    return;
  }
  try {
    const dates = await api(o, `/api/devices/${id}/log-dates`);
    const text = dates.length ? await api(o, `/api/devices/${id}/logs?date=${dates[0]}&tail=65536`, true) : '';
    result(text.includes(marker), '5. log stored', text.includes(marker) ? `in ${dates[0]}.log` : 'marker not in the newest log file');
  } catch (e) {
    result(false, '5. log stored', e.message);
  }
}

main()
  .catch((e) => result(false, 'check', e.message))
  .finally(() => {
    console.log(failed ? `\n${failed} step(s) FAILED` : '\nAll checks passed: the server is receiving packets.');
    process.exitCode = failed ? 1 : 0;
  });
