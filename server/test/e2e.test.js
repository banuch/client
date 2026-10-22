'use strict';
// Device -> TCP -> SQLite / log files -> REST, on random ports with a temp data dir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { start } = require('../src/server');
const { deviceKey } = require('../src/verify');
const { buildMessage } = require('../src/message');

const SECRET = 'test-master-secret-123';
const IMEI = '868123456789012';
const KEY = deviceKey(SECRET, IMEI);
const PASSWORD = 'view-password-1';

async function withServer(overrides, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-data-'));
  const s = await start({
    dataDir, tcpHost: '127.0.0.1', tcpPort: 0, httpHost: '127.0.0.1', httpPort: 0,
    masterSecret: SECRET, viewPassword: PASSWORD, requireSigned: false, ...overrides,
  }, { log: () => {} });
  try {
    await fn(s, dataDir);
  } finally {
    await s.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

/** Send bytes, wait for `lines` reply lines, return them parsed. */
function send(port, data, lines) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(data));
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      const got = buf.split('\n').filter(Boolean);
      if (got.length >= lines) {
        sock.end();
        resolve(got.map((l) => JSON.parse(l)));
      }
    });
    sock.on('error', reject);
    sock.on('close', () => resolve(buf.split('\n').filter(Boolean).map((l) => JSON.parse(l))));
  });
}

function get(s, p, { auth = true, text = false } = {}) {
  const headers = auth ? { Authorization: 'Basic ' + Buffer.from(`admin:${PASSWORD}`).toString('base64') } : {};
  return fetch(`http://127.0.0.1:${s.httpPort}${p}`, { headers }).then(async (r) => ({
    status: r.status, body: text ? await r.text() : await r.json(),
  }));
}

const READING = {
  ret: 0,
  values: [
    { obis: '0.0.96.1.0.255', name: 'Meter Serial Number', s: 'X1234567' },
    { obis: '1.0.32.7.0.255', name: 'Voltage R', v: 231.5, u: 'V' },
  ],
};

test('signed reading and log are stored and served', async () => {
  await withServer({}, async (s, dataDir) => {
    const replies = await send(s.tcpPort, Buffer.concat([
      buildMessage({ type: 'READING', deviceId: IMEI, boot: 9, seq: 0, fw: '2.0.1', ageS: 120, body: JSON.stringify(READING), key: KEY }),
      buildMessage({ type: 'LOG', deviceId: IMEI, boot: 9, seq: 0, dropped: 2, uptimeS: 400, body: 'Start reading\r\nline 2\r\n', key: KEY }),
    ]), 2);
    assert.deepStrictEqual(replies, [{ ok: true, type: 'READING', seq: 0 }, { ok: true, type: 'LOG', seq: 0 }]);

    const devices = await get(s, '/api/devices');
    assert.strictEqual(devices.status, 200);
    assert.strictEqual(devices.body.length, 1);
    assert.strictEqual(devices.body[0].id, IMEI);
    assert.strictEqual(devices.body[0].verified, 1);
    assert.strictEqual(devices.body[0].fw, '2.0.1');
    assert.strictEqual(devices.body[0].lastValueCount, 2);

    const latest = await get(s, `/api/devices/${IMEI}/latest`);
    assert.strictEqual(latest.body.values.length, 2);
    assert.strictEqual(latest.body.values[1].num, 231.5);
    assert.ok(latest.body.receivedAt - latest.body.readAt === 120000, 'readAt = receivedAt - ageS');

    const hist = await get(s, `/api/devices/${IMEI}/readings?obis=1.0.32.7.0.255`);
    assert.deepStrictEqual(hist.body.map((r) => r.num), [231.5]);

    const dates = await get(s, `/api/devices/${IMEI}/log-dates`);
    assert.strictEqual(dates.body.length, 1);
    const log = await get(s, `/api/devices/${IMEI}/logs?date=${dates.body[0]}`, { text: true });
    assert.match(log.body, /upload boot=9 seq=0 .* verified/);
    assert.match(log.body, /Start reading\nline 2\n/);
    assert.ok(fs.existsSync(path.join(dataDir, 'logs', IMEI, `${dates.body[0]}.log`)));
  });
});

test('bytes exactly as the firmware formats them (log_bridge.ino, reading_upload.ino)', async () => {
  const crypto = require('crypto');
  await withServer({}, async (s) => {
    // rd_end(): {"ret":N,"values":[...]} with "%.4f" numbers
    const body = '{"ret":0,"values":[{"obis":"1.0.32.7.0.255","name":"Voltage R","v":231.5000,"u":"V"},' +
      '{"obis":"0.0.96.1.0.255","name":"Meter Serial \\"A\\"","s":"X1"}]}';
    const hash = crypto.createHash('sha256').update(body).digest('hex');
    const surface = `READING|${IMEI}|3735928559|7|${hash}`;
    const sig = crypto.createHmac('sha256', KEY).update(surface).digest('hex');
    // lb_sendReading(): fixed field order, sig appended last
    const header = `{"type":"READING","deviceId":"${IMEI}","boot":3735928559,"seq":7,"fw":"2.0.1",` +
      `"ageS":42,"bytes":${Buffer.byteLength(body)},"sig":"${sig}"}\n`;
    const replies = await send(s.tcpPort, Buffer.from(header + body), 1);
    assert.deepStrictEqual(replies, [{ ok: true, type: 'READING', seq: 7 }]);
    const latest = await get(s, `/api/devices/${IMEI}/latest`);
    assert.strictEqual(latest.body.verified, 1);
    assert.strictEqual(latest.body.values[1].name, 'Meter Serial "A"');
  });
});

test('resent messages are stored once', async () => {
  await withServer({}, async (s) => {
    const r = buildMessage({ type: 'READING', deviceId: IMEI, boot: 3, seq: 5, body: JSON.stringify(READING), key: KEY });
    const l = buildMessage({ type: 'LOG', deviceId: IMEI, boot: 3, seq: 5, body: 'abc', key: KEY });
    await send(s.tcpPort, Buffer.concat([r, l]), 2);
    const again = await send(s.tcpPort, Buffer.concat([r, l]), 2);
    assert.deepStrictEqual(again, [
      { ok: true, type: 'READING', seq: 5, dup: true },
      { ok: true, type: 'LOG', seq: 5, dup: true },
    ]);
    const list = await get(s, `/api/devices/${IMEI}/readings`);
    assert.strictEqual(list.body.length, 1);
    const dates = await get(s, `/api/devices/${IMEI}/log-dates`);
    const log = await get(s, `/api/devices/${IMEI}/logs?date=${dates.body[0]}`, { text: true });
    assert.strictEqual(log.body.match(/upload boot=/g).length, 1);
  });
});

test('2.0.0 log bridge (no boot, unsigned) is accepted, never deduplicated', async () => {
  await withServer({}, async (s) => {
    const old = (seq) => Buffer.from(JSON.stringify({ type: 'LOG', deviceId: 'ESP-7D7734', seq, bytes: 3, dropped: 0, uptimeS: 1 }) + '\nabc');
    await send(s.tcpPort, old(0), 1);
    const r = await send(s.tcpPort, old(0), 1);   // seq 0 again after a reboot
    assert.deepStrictEqual(r, [{ ok: true, type: 'LOG', seq: 0 }]);
    const devices = await get(s, '/api/devices');
    assert.strictEqual(devices.body[0].verified, 0);
  });
});

test('bad signature is rejected, connection stays usable', async () => {
  await withServer({}, async (s) => {
    const wrongKey = deviceKey('some-other-secret-1', IMEI);
    const replies = await send(s.tcpPort, Buffer.concat([
      buildMessage({ type: 'READING', deviceId: IMEI, boot: 1, seq: 0, body: JSON.stringify(READING), key: wrongKey }),
      buildMessage({ type: 'READING', deviceId: IMEI, boot: 1, seq: 1, body: JSON.stringify(READING), key: KEY }),
    ]), 2);
    assert.deepStrictEqual(replies, [
      { ok: false, seq: 0, error: 'bad_signature' },
      { ok: true, type: 'READING', seq: 1 },
    ]);
  });
});

test('REQUIRE_SIGNED rejects unsigned data', async () => {
  await withServer({ requireSigned: true }, async (s) => {
    const replies = await send(s.tcpPort,
      buildMessage({ type: 'READING', deviceId: IMEI, boot: 1, seq: 0, body: JSON.stringify(READING) }), 1);
    assert.deepStrictEqual(replies, [{ ok: false, seq: 0, error: 'signature_required' }]);
    assert.deepStrictEqual((await get(s, '/api/devices')).body, []);
  });
});

test('framing error closes the connection', async () => {
  await withServer({}, async (s) => {
    const replies = await send(s.tcpPort, Buffer.from('hello\n'), 1);
    assert.deepStrictEqual(replies, [{ ok: false, error: 'header is not valid JSON' }]);
  });
});

test('web page needs the password, locks out after repeated failures', async () => {
  await withServer({ loginMaxFails: 3 }, async (s) => {
    assert.strictEqual((await get(s, '/api/health', { auth: false })).status, 200);
    assert.strictEqual((await get(s, '/api/devices', { auth: false })).status, 401);
    const wrong = { Authorization: 'Basic ' + Buffer.from('admin:wrong-password').toString('base64') };
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`http://127.0.0.1:${s.httpPort}/api/devices`, { headers: wrong });
      assert.strictEqual(r.status, 401);
    }
    assert.strictEqual((await get(s, '/api/devices')).status, 429, 'locked even with the right password');
  });
});

test('unknown device and bad parameters', async () => {
  await withServer({}, async (s) => {
    assert.strictEqual((await get(s, '/api/devices/nope/latest')).status, 404);
    assert.strictEqual((await get(s, '/api/devices/..%2F..%2Fetc/latest')).status, 404);
    await send(s.tcpPort, buildMessage({ type: 'READING', deviceId: IMEI, boot: 1, seq: 0, body: JSON.stringify(READING), key: KEY }), 1);
    assert.strictEqual((await get(s, `/api/devices/${IMEI}/readings?obis=x`)).status, 400);
    assert.strictEqual((await get(s, `/api/devices/${IMEI}/logs?date=2020-01-01`)).status, 404);
    assert.strictEqual((await get(s, `/api/devices/${IMEI}/logs?date=../../x`)).status, 404);
  });
});

test('retention removes old readings and keeps the newest', async () => {
  let now = Date.UTC(2026, 9, 1);
  await withServer({ clock: () => now }, async (s) => {
    await send(s.tcpPort, buildMessage({ type: 'READING', deviceId: IMEI, boot: 1, seq: 0, body: JSON.stringify(READING), key: KEY }), 1);
    now += 10 * 86400 * 1000;
    await send(s.tcpPort, buildMessage({ type: 'READING', deviceId: IMEI, boot: 1, seq: 1, body: JSON.stringify(READING), key: KEY }), 1);
    const { openDb } = require('../src/db');
    const db = openDb(s.cfg.dbFile);
    assert.strictEqual(db.prune(now - 5 * 86400 * 1000), 1);
    db.close();
    const list = await get(s, `/api/devices/${IMEI}/readings?from=0`);
    assert.strictEqual(list.body.length, 1);
    assert.ok((await get(s, `/api/devices/${IMEI}/latest`)).body);
  });
});
