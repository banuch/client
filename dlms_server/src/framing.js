'use strict';
// =============================================================================
//  framing.js  --  device message framing on the TCP port
//
//  A connection carries any number of messages. Each one is a JSON header
//  line followed by exactly `bytes` bytes of body:
//
//    {"type":"READING","deviceId":"<IMEI>","boot":B,"seq":N,"fw":"2.0.1",
//     "ageS":A,"bytes":M,"sig":"<64 hex>"}\n<M bytes of JSON>
//    {"type":"LOG","deviceId":"<IMEI>","boot":B,"seq":N,"bytes":M,
//     "dropped":D,"uptimeS":U,"sig":"<64 hex>"}\n<M bytes of trace text>
//
//  A header without boot (the 2.0.0 log bridge) is accepted with boot 0.
//  Any framing error ends the connection: after a bad header the parser
//  cannot know where the next message starts.
// =============================================================================

const TYPES = new Set(['READING', 'LOG']);
// First character alphanumeric: the id is also a folder name (log-store.js),
// so "." and ".." must not be possible.
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const UINT32_MAX = 0xffffffff;

function isUint(v, max = UINT32_MAX) {
  return Number.isInteger(v) && v >= 0 && v <= max;
}

/**
 * Check a parsed header. Returns an error string, or '' if it is valid.
 * Fills in defaults for optional fields.
 */
function validateHeader(h, limits) {
  if (!h || typeof h !== 'object' || Array.isArray(h)) return 'header must be a JSON object';
  if (!TYPES.has(h.type)) return 'type must be READING or LOG';
  if (typeof h.deviceId !== 'string' || !DEVICE_ID.test(h.deviceId)) {
    return 'deviceId must be 1-64 characters A-Z a-z 0-9 _ . - starting with a letter or digit';
  }
  if (h.boot === undefined) h.boot = 0;
  if (!isUint(h.boot)) return 'boot must be an unsigned 32-bit integer';
  if (!isUint(h.seq)) return 'seq must be an unsigned 32-bit integer';
  const max = h.type === 'READING' ? limits.maxReadingBytes : limits.maxLogBytes;
  if (!isUint(h.bytes, max)) return `bytes must be 0..${max} for ${h.type}`;
  if (h.sig !== undefined && (typeof h.sig !== 'string' || !/^[0-9a-fA-F]{64}$/.test(h.sig))) {
    return 'sig must be 64 hex characters';
  }
  for (const k of ['ageS', 'dropped', 'uptimeS']) {
    if (h[k] === undefined) h[k] = 0;
    else if (!isUint(h[k])) return `${k} must be an unsigned integer`;
  }
  if (h.fw !== undefined && (typeof h.fw !== 'string' || h.fw.length > 32)) return 'fw must be a short string';
  return '';
}

/**
 * Incremental parser. push() each chunk from the socket; it calls
 * onMessage({header, body}) per complete message and onError(msg) once on
 * the first framing error (after which it ignores further data).
 */
class FrameParser {
  constructor(limits, onMessage, onError) {
    this.limits = limits;
    this.onMessage = onMessage;
    this.onError = onError;
    this.buf = Buffer.alloc(0);
    this.header = null;
    this.failed = false;
  }

  push(chunk) {
    if (this.failed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (!this.failed) {
      if (!this.header) {
        const nl = this.buf.indexOf(0x0a);
        if (nl === -1) {
          if (this.buf.length > this.limits.maxHeaderBytes) this.fail('header line too long');
          return;
        }
        if (nl > this.limits.maxHeaderBytes) return this.fail('header line too long');
        const line = this.buf.subarray(0, nl).toString('utf8').replace(/\r$/, '');
        this.buf = this.buf.subarray(nl + 1);
        if (line.trim() === '') continue;   // tolerate blank lines between messages
        let h;
        try {
          h = JSON.parse(line);
        } catch {
          return this.fail('header is not valid JSON');
        }
        const err = validateHeader(h, this.limits);
        if (err) return this.fail(err);
        this.header = h;
      }
      if (this.buf.length < this.header.bytes) return;
      const body = Buffer.from(this.buf.subarray(0, this.header.bytes));
      this.buf = this.buf.subarray(this.header.bytes);
      const header = this.header;
      this.header = null;
      this.onMessage({ header, body });
    }
  }

  /** True while part of a message has been received. */
  get partial() {
    return this.header !== null || this.buf.length > 0;
  }

  fail(msg) {
    this.failed = true;
    this.buf = Buffer.alloc(0);
    this.onError(msg);
  }
}

module.exports = { FrameParser, validateHeader };
