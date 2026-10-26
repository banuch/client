'use strict';
// =============================================================================
//  hmac.js  --  request verification and replay guard
//
//  Device key and signature: shared/device-key.js (same as dlms_server).
//
//  Signed surfaces (must match firmware ota_client.ino exactly):
//    /ota/check   "<imei>|<current_ver>|<ts>"
//    /ota/report  "<imei>|<version>|<status>|<ts>"
// =============================================================================
const { deviceKey, sign, safeEqualHex } = require('../../shared/device-key');

// Rejects a signature seen before within the timestamp window, so a sniffed
// request cannot be replayed to mint a second token or a fake report.
class ReplayGuard {
  constructor(windowSec) {
    this.windowMs = windowSec * 2 * 1000;
    this.seen = new Map();
  }
  checkAndRemember(sig) {
    const now = Date.now();
    if (this.seen.size > 5000) {
      for (const [k, exp] of this.seen) if (exp < now) this.seen.delete(k);
    }
    const exp = this.seen.get(sig);
    if (exp && exp >= now) return false;
    this.seen.set(sig, now + this.windowMs);
    return true;
  }
}

/**
 * Verify a signed device request.
 * @returns {{ok:true}|{ok:false,status:number,error:string}}
 */
function verifyRequest({ masterSecret, imei, surface, ts, sig, windowSec, replayGuard, nowSec }) {
  if (!/^\d{14,17}$/.test(String(imei || ''))) return { ok: false, status: 400, error: 'bad_device_id' };
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return { ok: false, status: 400, error: 'bad_timestamp' };
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > windowSec) return { ok: false, status: 401, error: 'timestamp_out_of_window' };
  const expected = sign(deviceKey(masterSecret, imei), surface);
  if (!safeEqualHex(expected, sig)) return { ok: false, status: 401, error: 'bad_signature' };
  if (replayGuard && !replayGuard.checkAndRemember(expected)) {
    return { ok: false, status: 401, error: 'replayed_request' };
  }
  return { ok: true };
}

module.exports = { deviceKey, sign, safeEqualHex, verifyRequest, ReplayGuard };
