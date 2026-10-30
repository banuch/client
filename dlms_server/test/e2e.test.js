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

test('profile rows are stored once and served by profile', async () => {
  const block = (rows) => ({
    obis: '1.0.99.1.0.255', name: 'Block Load Profile',
    cols: [{ obis: '0.0.1.0.0.255', name: 'Clock', u: '' }, { obis: '1.0.1.29.0.255', name: 'Block kWh', u: 'kWh' }],
    rows: rows.map(([t, kwh]) => ({ t, c: [t, kwh] })),
  });
  const events = {
    obis: '0.0.99.98.0.255', name: 'Event Log: Voltage',
    cols: [{ obis: '0.0.1.0.0.255', name: 'Clock', u: '' }, { obis: '0.0.96.11.0.255', name: 'Event Code: Voltage', u: '' }],
    rows: [{ t: '2026-03-07 22:56:25', c: ['2026-03-07 22:56:25', 7], e: 'Over voltage - Occ' }],
  };
  const nameplate = {
    obis: '0.0.94.91.10.255', name: 'Name Plate Profile',
    cols: [{ obis: '0.0.96.1.0.255', name: 'Meter Serial Number', u: '' }],
    rows: [{ t: null, c: ['X1234567'] }],
  };
  await withServer({}, async (s) => {
    const msg = (seq, profiles) => buildMessage({ type: 'READING', deviceId: IMEI, boot: 4, seq, fw: '2.0.2',
      body: JSON.stringify({ ...READING, profiles }), key: KEY });
    // The second reading repeats a block (sent again after an outage) and the name plate.
    const replies = await send(s.tcpPort, Buffer.concat([
      msg(0, [block([['2026-10-23 10:00:00', 0.5], ['2026-10-23 10:30:00', 0.42]]), events, nameplate]),
      msg(1, [block([['2026-10-23 10:30:00', 0.42], ['2026-10-23 11:00:00', 0.61]]), nameplate]),
    ]), 2);
    assert.deepStrictEqual(replies, [{ ok: true, type: 'READING', seq: 0 }, { ok: true, type: 'READING', seq: 1 }]);

    const list = await get(s, `/api/devices/${IMEI}/profiles`);
    assert.deepStrictEqual(list.body.map((p) => [p.obis, p.rowCount, p.lastT]), [
      ['0.0.94.91.10.255', 1, null],
      ['0.0.99.98.0.255', 1, '2026-03-07 22:56:25'],
      ['1.0.99.1.0.255', 3, '2026-10-23 11:00:00'],
    ]);
    assert.strictEqual(list.body[2].cols[1].unit, 'kWh');

    const rows = await get(s, `/api/devices/${IMEI}/profiles/1.0.99.1.0.255`);
    assert.deepStrictEqual(rows.body.rows.map((r) => [r.t, r.c[1]]),
      [['2026-10-23 11:00:00', 0.61], ['2026-10-23 10:30:00', 0.42], ['2026-10-23 10:00:00', 0.5]]);
    assert.strictEqual(rows.body.rows[0].verified, 1);

    const range = await get(s, `/api/devices/${IMEI}/profiles/1.0.99.1.0.255?from=2026-10-23%2010:15&to=2026-10-23%2010:45`);
    assert.deepStrictEqual(range.body.rows.map((r) => r.t), ['2026-10-23 10:30:00']);
    const day = await get(s, `/api/devices/${IMEI}/profiles/1.0.99.1.0.255?to=2026-10-23`);
    assert.strictEqual(day.body.rows.length, 3, 'a bare "to" date includes the whole day');

    const ev = await get(s, `/api/devices/${IMEI}/profiles/0.0.99.98.0.255`);
    assert.strictEqual(ev.body.rows[0].e, 'Over voltage - Occ');

    // A block sent again with other values replaces the stored one.
    await send(s.tcpPort, msg(2, [block([['2026-10-23 11:00:00', 0.65]])]), 1);
    const fixed = await get(s, `/api/devices/${IMEI}/profiles/1.0.99.1.0.255`);
    assert.deepStrictEqual(fixed.body.rows.map((r) => r.c[1]), [0.65, 0.42, 0.5]);

    assert.strictEqual((await get(s, `/api/devices/${IMEI}/profiles/1.0.99.2.0.255`)).status, 404);
    assert.strictEqual((await get(s, `/api/devices/${IMEI}/profiles/x`)).status, 400);
    assert.strictEqual((await get(s, `/api/devices/${IMEI}/profiles/1.0.99.1.0.255?from=yesterday`)).status, 400);
  });
});

test('profiles exactly as the firmware formats them (reading_upload.ino rd_profile*)', async () => {
  await withServer({}, async (s) => {
    const body = '{"ret":0,"values":[],"profiles":[{"obis":"1.0.98.1.0.255","name":"Billing Profile",' +
      '"cols":[{"obis":"0.0.0.1.2.255","name":"Billing Date","u":""},{"obis":"1.0.1.8.0.255","name":"Active Energy Import","u":"kWh"}],' +
      '"rows":[{"t":"2026-10-01 00:00:00","c":["2026-10-01 00:00:00",23415.63]},' +
      '{"t":"2026-10-23 10:31:02","c":["2026-10-23 10:31:02",23496.05]}]},' +
      '{"obis":"0.0.99.98.3.255","name":"Event Log: Transaction","cols":[],"rows":[]}]}';
    const replies = await send(s.tcpPort, buildMessage({ type: 'READING', deviceId: IMEI, boot: 2, seq: 0, fw: '2.0.2', body, key: KEY }), 1);
    assert.deepStrictEqual(replies, [{ ok: true, type: 'READING', seq: 0 }]);
    const p = await get(s, `/api/devices/${IMEI}/profiles/1.0.98.1.0.255`);
    assert.deepStrictEqual(p.body.rows.map((r) => r.c[1]), [23496.05, 23415.63]);
  });
});

const BILLING_COLS = [{ obis: '0.0.0.1.2.255', name: 'Billing Date' }, { obis: '1.0.1.8.0.255', name: 'Active Energy Import', u: 'kWh' }];
/** A reading whose billing profile has a closed month and the open month at the meter clock `now`. */
const billingReading = (now, kwh, closed = '2026-10-01 00:00:00') => JSON.stringify({
  ret: 0,
  values: [{ obis: '0.0.1.0.0.255', name: 'Clock', s: now }],
  profiles: [{ obis: '1.0.98.1.0.255', name: 'Billing Profile', cols: BILLING_COLS,
    rows: [{ t: closed, c: [closed, 23415.63] }, { t: now, c: [now, kwh] }] }],
});

test('the open billing row is replaced, not added again every cycle', async () => {
  await withServer({}, async (s) => {
    const msgs = [['2026-10-29 16:00:22', 23545.4], ['2026-10-29 16:30:21', 23545.7], ['2026-10-29 17:00:22', 23546.0]]
      .map(([now, kwh], seq) => buildMessage({ type: 'READING', deviceId: IMEI, boot: 3, seq, body: billingReading(now, kwh), key: KEY }));
    await send(s.tcpPort, Buffer.concat(msgs), 3);
    let p = await get(s, `/api/devices/${IMEI}/profiles/1.0.98.1.0.255`);
    assert.deepStrictEqual(p.body.rows.map((r) => [r.t, r.c[1]]),
      [['2026-10-29 17:00:22', 23546.0], ['2026-10-01 00:00:00', 23415.63]]);
    // The month closes: its row arrives with its real billing date and is kept.
    await send(s.tcpPort, buildMessage({ type: 'READING', deviceId: IMEI, boot: 3, seq: 3,
      body: billingReading('2026-11-01 00:30:00', 23600, '2026-11-01 00:00:00'), key: KEY }), 1);
    p = await get(s, `/api/devices/${IMEI}/profiles/1.0.98.1.0.255`);
    assert.deepStrictEqual(p.body.rows.map((r) => r.t), ['2026-11-01 00:30:00', '2026-11-01 00:00:00', '2026-10-01 00:00:00']);
  });
});

test('migration 1 folds the stored copies of the open billing row into one', async () => {
  await withServer({}, async (s) => {
    await send(s.tcpPort, buildMessage({ type: 'READING', deviceId: IMEI, boot: 4, seq: 0,
      body: billingReading('2026-10-29 16:00:22', 23545.4), key: KEY }), 1);
    const { openDb } = require('../src/db');
    let db = openDb(s.cfg.dbFile);
    // Rebuild what older servers stored: every open row under its own time.
    db.db.prepare("UPDATE profile_rows SET row_key = 't:' || t WHERE row_key = 'open'").run();
    db.db.prepare(`INSERT INTO profile_rows (device_id, obis, t, cells, event, row_key, reading_id, received_at, verified)
      SELECT device_id, obis, '2026-10-29 15:30:21', cells, event, 't:2026-10-29 15:30:21', reading_id, received_at, verified
      FROM profile_rows WHERE t = '2026-10-29 16:00:22'`).run();
    db.db.pragma('user_version = 0');
    db.close();
    db = openDb(s.cfg.dbFile);
    const rows = db.profileRows({ deviceId: IMEI, obis: '1.0.98.1.0.255', limit: 10 }).rows;
    db.close();
    assert.deepStrictEqual(rows.map((r) => r.t), ['2026-10-29 16:00:22', '2026-10-01 00:00:00']);
    // The kept copy is the "open" row: the next cycle replaces it.
    await send(s.tcpPort, buildMessage({ type: 'READING', deviceId: IMEI, boot: 4, seq: 1,
      body: billingReading('2026-10-29 16:30:21', 23545.7), key: KEY }), 1);
    const p = await get(s, `/api/devices/${IMEI}/profiles/1.0.98.1.0.255`);
    assert.deepStrictEqual(p.body.rows.map((r) => r.t), ['2026-10-29 16:30:21', '2026-10-01 00:00:00']);
  });
});

test('a bad profile is skipped, the reading and good profiles are stored', async () => {
  await withServer({}, async (s) => {
    const good = { obis: '1.0.99.2.0.255', name: 'Daily Load Profile', cols: [{ obis: '0.0.1.0.0.255', name: 'Clock' }],
      rows: [{ t: '2026-10-23 00:00:00', c: ['2026-10-23 00:00:00'] }] };
    const body = JSON.stringify({ ...READING, profiles: [{ obis: '1.0.99.1.0.255', cols: [], rows: [{ t: 'now', c: [] }] }, good] });
    const replies = await send(s.tcpPort, buildMessage({ type: 'READING', deviceId: IMEI, boot: 1, seq: 0, body, key: KEY }), 1);
    assert.deepStrictEqual(replies[0], { ok: true, type: 'READING', seq: 0, skipped: 1 });
    const list = await get(s, `/api/devices/${IMEI}/profiles`);
    assert.deepStrictEqual(list.body.map((p) => p.obis), ['1.0.99.2.0.255']);
    assert.strictEqual((await get(s, `/api/devices/${IMEI}/latest`)).body.valueCount, READING.values.length);
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

test('sign-in page: session cookie, log out, no browser login popup', async () => {
  await withServer({}, async (s) => {
    const url = (p) => `http://127.0.0.1:${s.httpPort}${p}`;
    const login = (body, headers = { 'X-AMR-Data': '1' }) => fetch(url('/auth/login'), {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });

    const page = await fetch(url('/'), { redirect: 'manual' });
    assert.strictEqual(page.status, 302);
    assert.strictEqual(page.headers.get('location'), '/login.html');
    assert.strictEqual((await fetch(url('/login.html'))).status, 200);
    for (const file of ['/js/login.js', '/css/login.css', '/css/app.css']) {
      assert.strictEqual((await fetch(url(file))).status, 200, `${file} loads before sign-in`);
    }
    const api = await fetch(url('/api/meters'));
    assert.strictEqual(api.status, 401);
    assert.strictEqual(api.headers.get('www-authenticate'), null, 'no browser popup');

    assert.strictEqual((await login({ username: 'admin', password: PASSWORD }, {})).status, 403, 'CSRF header needed');
    assert.strictEqual((await login({ username: 'admin', password: 'wrong-password' })).status, 401);
    const ok = await login({ username: 'admin', password: PASSWORD });
    assert.strictEqual(ok.status, 200);
    const setCookie = ok.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const cookie = { Cookie: setCookie.split(';')[0] };

    assert.strictEqual((await fetch(url('/api/meters'), { headers: cookie })).status, 200);
    assert.strictEqual((await fetch(url('/'), { headers: cookie, redirect: 'manual' })).status, 200);
    assert.deepStrictEqual(await (await fetch(url('/auth/me'), { headers: cookie })).json(), { username: 'admin' });

    assert.strictEqual((await fetch(url('/auth/logout'), { method: 'POST', headers: { ...cookie, 'X-AMR-Data': '1' } })).status, 200);
    assert.strictEqual((await fetch(url('/api/meters'), { headers: cookie })).status, 401, 'session ended');
    assert.strictEqual((await fetch(url('/auth/me'), { headers: cookie })).status, 401);
  });
});

test('sign-in page: lockout, idle sessions end, browsers cannot use Basic', async () => {
  let now = Date.UTC(2026, 9, 1);
  await withServer({ loginMaxFails: 3, sessionIdleSec: 60, clock: () => now }, async (s) => {
    const url = (p) => `http://127.0.0.1:${s.httpPort}${p}`;
    const login = (password) => fetch(url('/auth/login'), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AMR-Data': '1' },
      body: JSON.stringify({ username: 'admin', password }),
    });

    const basic = { Authorization: 'Basic ' + Buffer.from(`admin:${PASSWORD}`).toString('base64') };
    assert.strictEqual((await fetch(url('/api/meters'), { headers: basic })).status, 200, 'scripts may use Basic');
    assert.strictEqual((await fetch(url('/api/meters'), { headers: { ...basic, 'Sec-Fetch-Site': 'same-origin' } })).status, 401,
      'a password the browser saved from the old popup does not count');

    const cookie = { Cookie: (await login(PASSWORD)).headers.get('set-cookie').split(';')[0] };
    now += 61 * 1000;
    assert.strictEqual((await fetch(url('/api/meters'), { headers: cookie })).status, 401, 'idle session ended');

    assert.strictEqual((await login('wrong-password')).status, 401);
    assert.strictEqual((await login('wrong-password')).status, 401);
    const locked = await login('wrong-password');
    assert.strictEqual(locked.status, 429);
    assert.ok((await locked.json()).retry_after_s > 0);
    assert.strictEqual((await login(PASSWORD)).status, 429, 'locked even with the right password');
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

test('device name: set, shown everywhere, kept when the device sends, cleared', async () => {
  await withServer({}, async (s) => {
    const put = (id, body, headers = { 'X-AMR-Data': '1' }) => fetch(`http://127.0.0.1:${s.httpPort}/api/devices/${id}/name`, {
      method: 'PUT',
      headers: { Authorization: 'Basic ' + Buffer.from(`admin:${PASSWORD}`).toString('base64'), 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const reading = (seq) => buildMessage({ type: 'READING', deviceId: IMEI, boot: 1, seq, body: JSON.stringify(READING), key: KEY });
    await send(s.tcpPort, reading(0), 1);
    assert.strictEqual((await get(s, '/api/meters')).body.meters[0].name, null);

    assert.strictEqual((await put('nope', { name: 'X' })).status, 404);
    assert.strictEqual((await put(IMEI, { name: 'X' }, {})).status, 403, 'needs the X-AMR-Data header');
    for (const name of [42, 'a'.repeat(65), 'tab\there', undefined]) {
      assert.strictEqual((await put(IMEI, { name })).status, 400, `rejects ${JSON.stringify(name)}`);
    }

    assert.deepStrictEqual((await put(IMEI, { name: '  Substation 3 – Feeder B  ' })).body, { id: IMEI, name: 'Substation 3 – Feeder B' });
    assert.strictEqual((await put(IMEI, { name: 'स'.repeat(64) })).status, 200, '64 characters, not bytes');
    await put(IMEI, { name: 'Substation 3 – Feeder B' });
    await send(s.tcpPort, reading(1), 1);
    assert.strictEqual((await get(s, '/api/meters')).body.meters[0].name, 'Substation 3 – Feeder B', 'a new message keeps the name');
    assert.strictEqual((await get(s, '/api/devices')).body[0].name, 'Substation 3 – Feeder B');
    const fleet = (await get(s, '/api/fleet')).body;
    assert.strictEqual(fleet.lastMessage.name, 'Substation 3 – Feeder B');

    assert.deepStrictEqual((await put(IMEI, { name: '   ' })).body, { id: IMEI, name: null });
    assert.strictEqual((await get(s, '/api/meters')).body.meters[0].name, null);
  });
});

test('migration 2 adds the name column to a database made before it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-data-'));
  try {
    const file = path.join(dir, 'old.db');
    const Database = require('better-sqlite3');
    const old = new Database(file);
    old.exec(`CREATE TABLE devices (id TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      last_ip TEXT, fw TEXT, verified INTEGER NOT NULL DEFAULT 0, last_reading_id INTEGER);
      INSERT INTO devices (id, first_seen, last_seen) VALUES ('${IMEI}', 1, 2);`);
    old.pragma('user_version = 1');
    old.close();
    const { openDb } = require('../src/db');
    const db = openDb(file);
    assert.strictEqual(db.db.pragma('user_version', { simple: true }), 2);
    assert.strictEqual(db.listDevices()[0].name, null);
    assert.ok(db.setName(IMEI, 'Pump house'));
    assert.strictEqual(db.listDevices()[0].name, 'Pump house');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test('overview endpoints: config, meters, fleet, stats, chart library', async () => {
  let now = Date.UTC(2026, 9, 28, 6);   // 11:30 IST
  await withServer({ clock: () => now }, async (s) => {
    const failed = { ret: 4, values: [] };
    await send(s.tcpPort, Buffer.concat([
      buildMessage({ type: 'READING', deviceId: IMEI, boot: 1, seq: 0, fw: '2.0.6', ageS: 60, body: JSON.stringify(READING), key: KEY }),
    ]), 1);
    now += 15 * 60000;
    await send(s.tcpPort, Buffer.concat([
      buildMessage({ type: 'READING', deviceId: IMEI, boot: 1, seq: 1, fw: '2.0.6', ageS: 0, body: JSON.stringify(failed), key: KEY }),
      buildMessage({ type: 'LOG', deviceId: IMEI, boot: 1, seq: 0, dropped: 3, uptimeS: 900, body: 'x\r\n', key: KEY }),
    ]), 2);

    const config = await get(s, '/api/config');
    assert.deepStrictEqual({ ...config.body, now: 0 }, { timezone: 'Asia/Kolkata', onlineAfterMin: 35, offlineAfterMin: 90, signing: 'checked', login: true, now: 0 });

    const meters = await get(s, '/api/meters');
    assert.strictEqual(meters.body.counts.total, 1);
    const m = meters.body.meters[0];
    assert.strictEqual(m.serial, 'X1234567');
    assert.strictEqual(m.status, 'online');
    assert.strictEqual(m.lastRet, 4);
    assert.deepStrictEqual(m.issues.map((i) => i.code), ['read_failed']);

    now += 60 * 60000;
    const fleet = await get(s, '/api/fleet');
    assert.strictEqual(fleet.body.counts.delayed, 1);
    assert.strictEqual(fleet.body.dayStart, Date.UTC(2026, 9, 27, 18, 30));
    assert.strictEqual(fleet.body.hours.length, 24);
    assert.deepStrictEqual(fleet.body.hours[11], { readings: 2, failed: 1, logs: 1 });
    assert.strictEqual(fleet.body.readingsToday, 2);
    assert.deepStrictEqual(fleet.body.attention.map((a) => a.id), [IMEI]);
    assert.deepStrictEqual(fleet.body.byFirmware, [{ fw: '2.0.6', online: 0, delayed: 1, offline: 0, total: 1 }]);

    const stats = await get(s, `/api/devices/${IMEI}/stats?days=3`);
    assert.strictEqual(stats.body.perDay.length, 3);
    assert.deepStrictEqual(stats.body.perDay[2], { readings: 2, failed: 1 });
    assert.strictEqual(stats.body.readings.n, 2);
    assert.deepStrictEqual(stats.body.logs, { n: 1, bytes: 3, dropped: 3 });
    assert.strictEqual(stats.body.lastLog.uptimeS, 900);
    assert.strictEqual((await get(s, '/api/devices/nope/stats')).status, 404);

    const chart = await fetch(`http://127.0.0.1:${s.httpPort}/vendor/chart.js`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`admin:${PASSWORD}`).toString('base64') },
    });
    assert.strictEqual(chart.status, 200);
    assert.match(await chart.text(), /Chart/);
  });
});
