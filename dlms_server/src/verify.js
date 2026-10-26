'use strict';
// =============================================================================
//  verify.js  --  message signatures
//
//  surface    = "<type>|<deviceId>|<boot>|<seq>|<sha256(body) hex>"
//
//  Device key and signature: shared/device-key.js, the same code the OTA
//  server uses, so a key issued there verifies here.
// =============================================================================
const crypto = require('crypto');
const { deviceKey, sign, safeEqualHex } = require('../../shared/device-key');

function surfaceOf(header, body) {
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  return `${header.type}|${header.deviceId}|${header.boot}|${header.seq}|${hash}`;
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
