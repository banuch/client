'use strict';
// =============================================================================
//  verify.js  --  message signatures
//
//  device_key = HMAC_SHA256(MASTER_SECRET, deviceId)    (lower-case hex, 64 chars)
//  sig        = HMAC_SHA256(device_key, surface)        (lower-case hex)
//  surface    = "<type>|<deviceId>|<boot>|<seq>|<sha256(body) hex>"
//
//  Same device key as the OTA server (ota_device_update/server/src/hmac.js):
//  the device stores it as the 64-char hex string and uses the ASCII bytes
//  of that string as its HMAC key -- so does this file.
// =============================================================================
const crypto = require('crypto');

function deviceKey(masterSecret, deviceId) {
  return crypto.createHmac('sha256', masterSecret).update(String(deviceId)).digest('hex');
}

function surfaceOf(header, body) {
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  return `${header.type}|${header.deviceId}|${header.boot}|${header.seq}|${hash}`;
}

function sign(key, surface) {
  return crypto.createHmac('sha256', key).update(surface).digest('hex');
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a.toLowerCase(), 'utf8');
  const bb = Buffer.from(b.toLowerCase(), 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Decide whether a message is accepted and whether it is verified.
 * @returns {{ok:true, verified:boolean} | {ok:false, error:string}}
 */
function checkMessage({ header, body, masterSecret, requireSigned }) {
  if (header.sig === undefined) {
    // Devices without a key yet (registration pending) send no signature.
    return requireSigned ? { ok: false, error: 'signature_required' } : { ok: true, verified: false };
  }
  if (!masterSecret) {
    // Nothing to check against; keep the data but do not call it verified.
    return requireSigned ? { ok: false, error: 'signature_required' } : { ok: true, verified: false };
  }
  const expected = sign(deviceKey(masterSecret, header.deviceId), surfaceOf(header, body));
  if (!safeEqualHex(expected, header.sig)) return { ok: false, error: 'bad_signature' };
  return { ok: true, verified: true };
}

module.exports = { deviceKey, surfaceOf, sign, safeEqualHex, checkMessage };
