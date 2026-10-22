'use strict';
// =============================================================================
//  message.js  --  build a device message (the firmware side, in JS)
//
//  Used by tools/send-sample.js and the tests. The firmware builds the same
//  bytes in log_bridge.ino / reading_upload.ino.
// =============================================================================
const { sign, surfaceOf } = require('./verify');

/**
 * @param {object} p  type, deviceId, boot, seq, body (Buffer|string), key (64-hex
 *                    device key, optional), plus extra header fields (fw, ageS, ...)
 * @returns {Buffer}  header line + body
 */
function buildMessage({ type, deviceId, boot, seq, body, key, ...extra }) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const header = { type, deviceId, boot, seq, ...extra, bytes: b.length };
  if (key) header.sig = sign(key, surfaceOf(header, b));
  return Buffer.concat([Buffer.from(JSON.stringify(header) + '\n', 'utf8'), b]);
}

module.exports = { buildMessage };
