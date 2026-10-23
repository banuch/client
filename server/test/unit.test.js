'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { FrameParser, validateHeader } = require('../src/framing');
const { checkMessage, deviceKey, sign, surfaceOf } = require('../src/verify');
const { parseReading } = require('../src/reading');
const { buildMessage } = require('../src/message');

const LIMITS = { maxHeaderBytes: 4096, maxReadingBytes: 1000, maxLogBytes: 5000 };
const SECRET = 'test-master-secret-123';
const IMEI = '868123456789012';

function collect(limits = LIMITS) {
  const out = { messages: [], errors: [] };
  out.parser = new FrameParser(limits, (m) => out.messages.push(m), (e) => out.errors.push(e));
  return out;
}

test('framing: two messages in one chunk', () => {
  const c = collect();
  c.parser.push(Buffer.concat([
    buildMessage({ type: 'LOG', deviceId: IMEI, boot: 1, seq: 0, body: 'abc' }),
    buildMessage({ type: 'LOG', deviceId: IMEI, boot: 1, seq: 1, body: 'defg' }),
  ]));
  assert.deepStrictEqual(c.errors, []);
  assert.strictEqual(c.messages.length, 2);
  assert.strictEqual(c.messages[1].body.toString(), 'defg');
  assert.strictEqual(c.parser.partial, false);
});

test('framing: a message split byte by byte', () => {
  const c = collect();
  const data = buildMessage({ type: 'LOG', deviceId: IMEI, boot: 1, seq: 7, body: 'line\nwith newline\n' });
  for (const b of data) c.parser.push(Buffer.from([b]));
  assert.strictEqual(c.messages.length, 1);
  assert.strictEqual(c.messages[0].body.toString(), 'line\nwith newline\n');
});

test('framing: body may contain anything, including JSON-looking lines', () => {
  const c = collect();
  const body = Buffer.from('{"type":"LOG"}\n\x00\xff');
  c.parser.push(buildMessage({ type: 'LOG', deviceId: IMEI, boot: 1, seq: 0, body }));
  assert.strictEqual(c.messages.length, 1);
  assert.ok(c.messages[0].body.equals(body));
});

test('framing: errors end the parse', () => {
  let c = collect();
  c.parser.push(Buffer.from('not json\n'));
  assert.deepStrictEqual(c.errors, ['header is not valid JSON']);
  c.parser.push(buildMessage({ type: 'LOG', deviceId: IMEI, boot: 1, seq: 0, body: 'x' }));
  assert.strictEqual(c.messages.length, 0);

  c = collect();
  c.parser.push(Buffer.alloc(5000, 0x41));
  assert.deepStrictEqual(c.errors, ['header line too long']);

  c = collect();
  c.parser.push(Buffer.from(JSON.stringify({ type: 'READING', deviceId: IMEI, seq: 0, bytes: 1001 }) + '\n'));
  assert.match(c.errors[0], /bytes must be 0\.\.1000/);
});

test('framing: header checks', () => {
  const ok = { type: 'LOG', deviceId: IMEI, seq: 0, bytes: 0 };
  assert.strictEqual(validateHeader({ ...ok }, LIMITS), '');
  const h = { ...ok };
  validateHeader(h, LIMITS);
  assert.strictEqual(h.boot, 0, 'boot defaults to 0 (2.0.0 firmware)');
  assert.match(validateHeader({ ...ok, type: 'X' }, LIMITS), /type/);
  assert.match(validateHeader({ ...ok, deviceId: '..' }, LIMITS), /deviceId/);
  assert.match(validateHeader({ ...ok, deviceId: '../etc' }, LIMITS), /deviceId/);
  assert.match(validateHeader({ ...ok, seq: -1 }, LIMITS), /seq/);
  assert.match(validateHeader({ ...ok, sig: 'zz' }, LIMITS), /sig/);
  assert.match(validateHeader([], LIMITS), /object/);
});

test('verify: signed, unsigned, wrong key, required', () => {
  const body = Buffer.from('hello');
  const header = { type: 'LOG', deviceId: IMEI, boot: 5, seq: 3 };
  header.sig = sign(deviceKey(SECRET, IMEI), surfaceOf(header, body));
  assert.deepStrictEqual(checkMessage({ header, body, masterSecret: SECRET }), { ok: true, verified: true });
  assert.deepStrictEqual(checkMessage({ header, body: Buffer.from('hellO'), masterSecret: SECRET }),
    { ok: false, error: 'bad_signature' });
  assert.deepStrictEqual(checkMessage({ header: { ...header, seq: 4 }, body, masterSecret: SECRET }),
    { ok: false, error: 'bad_signature' });
  assert.deepStrictEqual(checkMessage({ header, body, masterSecret: 'another-secret-12345' }),
    { ok: false, error: 'bad_signature' });
  const unsigned = { ...header, sig: undefined };
  assert.deepStrictEqual(checkMessage({ header: unsigned, body, masterSecret: SECRET }), { ok: true, verified: false });
  assert.deepStrictEqual(checkMessage({ header: unsigned, body, masterSecret: SECRET, requireSigned: true }),
    { ok: false, error: 'signature_required' });
  assert.deepStrictEqual(checkMessage({ header, body, masterSecret: '' }), { ok: true, verified: false });
});

test('verify: device key matches the OTA server formula', () => {
  // HMAC_SHA256("test-master-secret-123", "868123456789012"), as ota server tools/device-key.js
  const crypto = require('crypto');
  assert.strictEqual(deviceKey(SECRET, IMEI), crypto.createHmac('sha256', SECRET).update(IMEI).digest('hex'));
});

test('reading: valid body', () => {
  const r = parseReading(Buffer.from(JSON.stringify({
    ret: 0,
    values: [
      { obis: '1.0.1.8.0.255', name: 'kWh', v: 12.5, u: 'kWh' },
      { obis: '0.0.96.1.0.255', name: 'Serial', s: 'X1' },
      { obis: '1.0.32.7.0.255', v: 230 },
    ],
  })));
  assert.ok(r.ok);
  assert.deepStrictEqual(r.reading.values[1], { obis: '0.0.96.1.0.255', name: 'Serial', num: null, unit: '', text: 'X1' });
  assert.strictEqual(r.reading.values[2].unit, '');
});

const PROFILE = {
  obis: '1.0.99.1.0.255',
  name: 'Block Load Profile',
  cols: [{ obis: '0.0.1.0.0.255', name: 'Clock', u: '' }, { obis: '1.0.1.29.0.255', name: 'Block kWh', u: 'kWh' }],
  rows: [{ t: '2026-10-23 10:30:00', c: ['2026-10-23 10:30:00', 0.42] }],
};

test('reading: profiles', () => {
  const r = parseReading(Buffer.from(JSON.stringify({ ret: 0, values: [], profiles: [PROFILE] })));
  assert.ok(r.ok, r.error);
  assert.deepStrictEqual(r.reading.profiles[0].cols[1], { obis: '1.0.1.29.0.255', name: 'Block kWh', unit: 'kWh' });
  assert.deepStrictEqual(r.reading.profiles[0].rows[0], { t: '2026-10-23 10:30:00', c: ['2026-10-23 10:30:00', 0.42], e: null });
  // Without profiles (FW 2.0.1) the list is empty.
  assert.deepStrictEqual(parseReading(Buffer.from('{"ret":0,"values":[]}')).reading.profiles, []);
  // Event rows, rows without time, missing cells.
  const ev = parseReading(Buffer.from(JSON.stringify({ ret: 0, values: [], profiles: [{ ...PROFILE,
    rows: [{ t: null, c: [null, 7], e: 'Over voltage - Occ' }] }] })));
  assert.ok(ev.ok, ev.error);
  assert.strictEqual(ev.reading.profiles[0].rows[0].e, 'Over voltage - Occ');
});

test('reading: bad profiles', () => {
  const bad = (p) => parseReading(Buffer.from(JSON.stringify({ ret: 0, values: [], profiles: p })));
  assert.match(bad({}).error, /profiles must be an array/);
  assert.match(bad([{ ...PROFILE, obis: 'x' }]).error, /profiles\[0\]\.obis/);
  assert.match(bad([{ ...PROFILE, cols: [{ obis: '1.2' }] }]).error, /cols\[0\]\.obis/);
  assert.match(bad([{ ...PROFILE, rows: [{ t: '23-10-2026', c: [] }] }]).error, /rows\[0\]\.t/);
  assert.match(bad([{ ...PROFILE, rows: [{ t: null, c: [1, 2, 3] }] }]).error, /one cell per column/);
  assert.match(bad([{ ...PROFILE, rows: [{ t: null, c: [{}] }] }]).error, /c\[0\] must be/);
  assert.match(bad([{ ...PROFILE, rows: [{ t: null, c: [], e: 5 }] }]).error, /\.e must be/);
});

test('reading: bad bodies', () => {
  const bad = (o) => parseReading(Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)));
  assert.ok(!bad('{').ok);
  assert.ok(!bad({ values: [] }).ok, 'ret missing');
  assert.ok(!bad({ ret: 0, values: [{ obis: '1.2.3', v: 1 }] }).ok);
  assert.ok(!bad({ ret: 0, values: [{ obis: '1.0.1.8.0.255' }] }).ok, 'needs v or s');
  assert.ok(!bad({ ret: 0, values: [{ obis: '1.0.1.8.0.255', v: 'x' }] }).ok);
  assert.ok(!bad({ ret: 0, values: [{ obis: '1.0.1.8.0.255', s: 'x'.repeat(300) }] }).ok);
});
