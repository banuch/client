'use strict';
// =============================================================================
//  reading.js  --  READING body
//
//    {"ret":0,"values":[
//      {"obis":"1.0.1.8.0.255","name":"Cumulative Energy kWh","v":12.345,"u":"kWh"},
//      {"obis":"0.0.96.1.0.255","name":"Meter Serial Number","s":"X1234567"}, ...]}
//
//  ret is the meter cycle's result code (0 = OK, see the DLMS error codes).
//  Each value has a number + unit (v, u) or a text (s), as on the BLE link.
// =============================================================================

const OBIS = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const MAX_VALUES = 2000;

function shortString(v, max) {
  return typeof v === 'string' && v.length <= max;
}

/**
 * Parse and check a READING body.
 * @returns {{ok:true, reading:{ret:number, values:Array}} | {ok:false, error:string}}
 */
function parseReading(body) {
  let r;
  try {
    r = JSON.parse(body.toString('utf8'));
  } catch {
    return { ok: false, error: 'reading is not valid JSON' };
  }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, error: 'reading must be a JSON object' };
  if (!Number.isInteger(r.ret)) return { ok: false, error: 'ret must be an integer' };
  if (!Array.isArray(r.values) || r.values.length > MAX_VALUES) {
    return { ok: false, error: `values must be an array of at most ${MAX_VALUES}` };
  }
  const values = [];
  for (const [i, v] of r.values.entries()) {
    if (!v || typeof v !== 'object' || !shortString(v.obis, 23) || !OBIS.test(v.obis)) {
      return { ok: false, error: `values[${i}].obis must be an OBIS code a.b.c.d.e.f` };
    }
    const name = v.name === undefined ? '' : v.name;
    if (!shortString(name, 64)) return { ok: false, error: `values[${i}].name must be a string of at most 64` };
    if (v.v !== undefined) {
      if (typeof v.v !== 'number' || !Number.isFinite(v.v)) return { ok: false, error: `values[${i}].v must be a number` };
      const unit = v.u === undefined ? '' : v.u;
      if (!shortString(unit, 16)) return { ok: false, error: `values[${i}].u must be a string of at most 16` };
      values.push({ obis: v.obis, name, num: v.v, unit, text: null });
    } else if (v.s !== undefined) {
      if (!shortString(v.s, 256)) return { ok: false, error: `values[${i}].s must be a string of at most 256` };
      values.push({ obis: v.obis, name, num: null, unit: '', text: v.s });
    } else {
      return { ok: false, error: `values[${i}] needs v or s` };
    }
  }
  return { ok: true, reading: { ret: r.ret, values } };
}

module.exports = { parseReading };
