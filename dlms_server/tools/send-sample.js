#!/usr/bin/env node
'use strict';
// =============================================================================
//  send-sample.js  --  act as a device: send one READING and one LOG
//
//    node tools/send-sample.js [host] [port] [imei]
//
//  Signs the messages when MASTER_SECRET is set (environment or .env), the
//  same way an approved device does. Prints the server's reply lines.
// =============================================================================
const net = require('net');
const crypto = require('crypto');
const { loadConfig } = require('../src/config');
const { deviceKey } = require('../src/verify');
const { buildMessage } = require('../src/message');

const cfg = loadConfig();
const host = process.argv[2] || '127.0.0.1';
const port = Number(process.argv[3] || cfg.tcpPort);
const deviceId = process.argv[4] || '868123456789012';
const key = cfg.masterSecret ? deviceKey(cfg.masterSecret, deviceId) : undefined;
const boot = crypto.randomInt(1, 0xffffffff);

const reading = {
  ret: 0,
  values: [
    { obis: '0.0.96.1.0.255', name: 'Meter Serial Number', s: 'SAMPLE001' },
    { obis: '1.0.32.7.0.255', name: 'Voltage R', v: 230 + Math.random() * 5, u: 'V' },
    { obis: '1.0.31.7.0.255', name: 'Current R', v: Math.random() * 10, u: 'A' },
    { obis: '1.0.1.8.0.255', name: 'Cumulative Energy kWh', v: 1000 + Math.random() * 10, u: 'kWh' },
  ],
  profiles: sampleProfiles(),
};

// Last two half-hour blocks and one event, in meter local time like FW 2.0.2.
function sampleProfiles() {
  const p = (n) => String(n).padStart(2, '0');
  const text = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const slot = new Date(Math.floor(Date.now() / 1800000) * 1800000);
  const blocks = [new Date(slot - 1800000), slot].map((d) => {
    const t = text(d);
    return { t, c: [t, 230 + Math.round(Math.random() * 50) / 10, Math.round(Math.random() * 500) / 1000] };
  });
  const ev = text(new Date(slot - 600000));
  return [
    {
      obis: '1.0.99.1.0.255', name: 'Block Load Profile',
      cols: [{ obis: '0.0.1.0.0.255', name: 'Clock', u: '' }, { obis: '1.0.32.27.0.255', name: 'Avg Voltage L1', u: 'V' },
        { obis: '1.0.1.29.0.255', name: 'Block kWh', u: 'kWh' }],
      rows: blocks,
    },
    {
      obis: '0.0.99.98.0.255', name: 'Event Log: Voltage',
      cols: [{ obis: '0.0.1.0.0.255', name: 'Clock', u: '' }, { obis: '0.0.96.11.0.255', name: 'Event Code: Voltage', u: '' }],
      rows: [{ t: ev, c: [ev, 7], e: 'Over voltage - Occ' }],
    },
  ];
}
const logText = `Start reading\r\nsample log line at ${new Date().toISOString()}\r\n`;

const data = Buffer.concat([
  buildMessage({ type: 'READING', deviceId, boot, seq: 0, fw: 'sample', ageS: 0, body: JSON.stringify(reading), key }),
  buildMessage({ type: 'LOG', deviceId, boot, seq: 0, dropped: 0, uptimeS: 60, body: logText, key }),
]);

const sock = net.connect(port, host, () => {
  console.log(`connected to ${host}:${port} as ${deviceId} (${key ? 'signed' : 'unsigned'})`);
  sock.write(data);
});
let replies = '';
sock.on('data', (d) => {
  replies += d.toString();
  if (replies.split('\n').length > 2) sock.end();
});
sock.on('close', () => console.log(replies.trim()));
sock.on('error', (e) => {
  console.error(e.message);
  process.exit(1);
});
