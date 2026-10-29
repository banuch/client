'use strict';
// =============================================================================
//  tcp-server.js  --  device port
//
//  Reads framed messages (framing.js), checks the signature (verify.js) and
//  stores them (db.js, log-store.js). Each message gets one reply line:
//
//    {"ok":true,"type":"READING","seq":N}            stored
//    {"ok":true,"type":"READING","seq":N,"dup":true} already stored before
//    {"ok":true,"type":"READING","seq":N,"skipped":K} stored without K bad profiles
//    {"ok":false,"seq":N,"error":"bad_signature"}    rejected, connection stays open
//    {"ok":false,"error":"<framing error>"}          then the connection is closed
//
//  FW 2.0.7+ waits for the reply to each READING before it forgets it and
//  saves its profile markers; LOG replies are not read.
// =============================================================================
const net = require('net');
const { FrameParser } = require('./framing');
const { checkMessage } = require('./verify');
const { parseReading } = require('./reading');

const MAX_AGE_S = 30 * 86400;   // a queued reading older than this is suspect

function createTcpServer(cfg, { db, logs, log = console.log }) {
  const limits = {
    maxHeaderBytes: cfg.maxHeaderBytes,
    maxReadingBytes: cfg.maxReadingBytes,
    maxLogBytes: cfg.maxLogBytes,
  };

  function handle({ header, body }, ip) {
    const now = cfg.clock();
    const check = checkMessage({ header, body, masterSecret: cfg.masterSecret, requireSigned: cfg.requireSigned });
    if (!check.ok) {
      log(`[TCP] ${ip} ${header.type} ${header.deviceId} seq=${header.seq} rejected: ${check.error}`);
      return { ok: false, seq: header.seq, error: check.error };
    }
    const base = { deviceId: header.deviceId, boot: header.boot, seq: header.seq, receivedAt: now, ip, verified: check.verified };
    const tag = check.verified ? '' : ' (unverified)';

    if (header.type === 'READING') {
      const parsed = parseReading(body);
      if (!parsed.ok) {
        log(`[TCP] ${ip} READING ${header.deviceId} seq=${header.seq} rejected: ${parsed.error}`);
        return { ok: false, seq: header.seq, error: parsed.error };
      }
      const age = Math.min(header.ageS, MAX_AGE_S);
      const { profiles, skipped } = parsed.reading;
      for (const k of skipped) log(`[TCP] READING ${header.deviceId} seq=${header.seq} profile ${k.obis} skipped: ${k.error}`);
      const { stored, newRows } = db.saveReading({
        ...base, fw: header.fw, readAt: now - age * 1000, ret: parsed.reading.ret, values: parsed.reading.values,
        profiles,
      });
      const rowCount = profiles.reduce((n, p) => n + p.rows.length, 0);
      const prof = profiles.length ? ` ${profiles.length} profiles ${rowCount} rows (${newRows} new)` : '';
      log(`[TCP] READING ${header.deviceId} seq=${header.seq} ${parsed.reading.values.length} values${prof}` +
        ` ret=${parsed.reading.ret} age=${age}s${stored ? '' : ' duplicate'}${tag}`);
      const res = { ok: true, type: 'READING', seq: header.seq };
      if (!stored) res.dup = true;
      if (skipped.length) res.skipped = skipped.length;
      return res;
    }

    // LOG
    if (db.isDuplicateLog(header.deviceId, header.boot, header.seq)) {
      db.touchDevice(header.deviceId, now, ip, check.verified);
      log(`[TCP] LOG ${header.deviceId} seq=${header.seq} duplicate${tag}`);
      return { ok: true, type: 'LOG', seq: header.seq, dup: true };
    }
    const file = logs.append({
      deviceId: header.deviceId, receivedAt: now, boot: header.boot, seq: header.seq, bytes: header.bytes,
      dropped: header.dropped, uptimeS: header.uptimeS, verified: check.verified, body,
    });
    db.saveLog({ ...base, bytes: header.bytes, dropped: header.dropped, uptimeS: header.uptimeS, file, verified: check.verified ? 1 : 0 });
    log(`[TCP] LOG ${header.deviceId} seq=${header.seq} ${header.bytes} bytes${tag}`);
    return { ok: true, type: 'LOG', seq: header.seq };
  }

  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const ip = (socket.remoteAddress || '').replace(/^::ffff:/, '');
    socket.setTimeout(cfg.idleTimeoutSec * 1000);
    const reply = (obj) => {
      if (socket.writable) socket.write(JSON.stringify(obj) + '\n');
    };
    const parser = new FrameParser(
      limits,
      (msg) => {
        let res;
        try {
          res = handle(msg, ip);
        } catch (err) {
          log(`[TCP] ${ip} ${msg.header.type} ${msg.header.deviceId} store failed: ${err.message}`);
          res = { ok: false, seq: msg.header.seq, error: 'store_failed' };
        }
        reply(res);
      },
      (error) => {
        log(`[TCP] ${ip} framing error: ${error}`);
        reply({ ok: false, error });
        socket.end();
      },
    );
    socket.on('data', (chunk) => parser.push(chunk));
    socket.on('timeout', () => {
      log(`[TCP] ${ip} idle timeout`);
      socket.destroy();
    });
    socket.on('error', () => {});   // resets from the modem side are normal
    socket.on('close', () => {
      if (parser.partial && !parser.failed) log(`[TCP] ${ip} closed in the middle of a message (discarded)`);
    });
  });
  server.maxConnections = cfg.maxConnections;
  // For shutdown: close() alone waits for every device to disconnect.
  server.destroyAll = () => {
    for (const s of sockets) s.destroy();
  };
  return server;
}

module.exports = { createTcpServer };
