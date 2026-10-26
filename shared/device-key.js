'use strict';
// =============================================================================
//  shared/device-key.js  --  device keys and HMAC signatures
//
//  Used by both servers so they always agree with each other and with the
//  firmware (ota_client.ino, register.ino, log_bridge.ino):
//
//  device_key = HMAC_SHA256(MASTER_SECRET, deviceId)    (lower-case hex, 64 chars)
//  signature  = HMAC_SHA256(device_key, surface)        (lower-case hex)
//
//  The device stores device_key as the 64-char hex string and uses the ASCII
//  bytes of that string as its HMAC key -- so does this file.
//
//  Signed surfaces:
//    ota_server   /ota/check   "<imei>|<current_ver>|<ts>"
//                 /ota/report  "<imei>|<version>|<status>|<ts>"
//    dlms_server  messages     "<type>|<deviceId>|<boot>|<seq>|<sha256(body) hex>"
// =============================================================================
const crypto = require('crypto');

function deviceKey(masterSecret, deviceId) {
  return crypto.createHmac('sha256', masterSecret).update(String(deviceId)).digest('hex');
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

module.exports = { deviceKey, sign, safeEqualHex };
