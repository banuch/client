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
//
//  FW 2.0.2 adds the new profile rows of the cycle (profiles.ino):
//
//    "profiles":[{"obis":"1.0.99.1.0.255","name":"Block Load Profile",
//      "cols":[{"obis":"0.0.1.0.0.255","name":"Clock","u":""}, ...],
//      "rows":[{"t":"2026-10-23 10:30:00","c":["2026-10-23 10:30:00",0.42,null,...]},
//              {"t":null,"c":[...],"e":"Over voltage - Occ"}]}]
//
//  t is the row's timestamp in meter local time (or null), c one cell per
//  column (number, string or null), e the event name of event log rows.
// =============================================================================

const OBIS = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const ROW_TIME = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;
const MAX_VALUES = 2000;
const MAX_PROFILES = 50;
const MAX_COLUMNS = 128;
const MAX_ROWS = 5000;

function shortString(v, max) {
  return typeof v === 'string' && v.length <= max;
}

/** Check the optional profiles array. Returns an error string or the parsed list. */
function parseProfiles(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > MAX_PROFILES) return `profiles must be an array of at most ${MAX_PROFILES}`;
  const out = [];
  for (const [i, p] of list.entries()) {
    const at = `profiles[${i}]`;
    if (!p || typeof p !== 'object' || !shortString(p.obis, 23) || !OBIS.test(p.obis)) {
      return `${at}.obis must be an OBIS code a.b.c.d.e.f`;
    }
    const name = p.name === undefined ? '' : p.name;
    if (!shortString(name, 64)) return `${at}.name must be a string of at most 64`;
    if (!Array.isArray(p.cols) || p.cols.length > MAX_COLUMNS) return `${at}.cols must be an array of at most ${MAX_COLUMNS}`;
    const cols = [];
    for (const [j, c] of p.cols.entries()) {
      if (!c || typeof c !== 'object' || !shortString(c.obis, 23) || !OBIS.test(c.obis)) {
        return `${at}.cols[${j}].obis must be an OBIS code a.b.c.d.e.f`;
      }
      const cname = c.name === undefined ? '' : c.name;
      const unit = c.u === undefined ? '' : c.u;
      if (!shortString(cname, 64)) return `${at}.cols[${j}].name must be a string of at most 64`;
      if (!shortString(unit, 16)) return `${at}.cols[${j}].u must be a string of at most 16`;
      cols.push({ obis: c.obis, name: cname, unit });
    }
    if (!Array.isArray(p.rows) || p.rows.length > MAX_ROWS) return `${at}.rows must be an array of at most ${MAX_ROWS}`;
    const rows = [];
    for (const [j, r] of p.rows.entries()) {
      const rat = `${at}.rows[${j}]`;
      if (!r || typeof r !== 'object' || Array.isArray(r)) return `${rat} must be an object`;
      const t = r.t === undefined ? null : r.t;
      if (t !== null && !(typeof t === 'string' && ROW_TIME.test(t))) return `${rat}.t must be "YYYY-MM-DD hh:mm:ss" or null`;
      if (!Array.isArray(r.c) || r.c.length > cols.length) return `${rat}.c must be an array of at most one cell per column`;
      for (const [k, cell] of r.c.entries()) {
        const ok = cell === null || (typeof cell === 'number' && Number.isFinite(cell)) || shortString(cell, 256);
        if (!ok) return `${rat}.c[${k}] must be a number, a string of at most 256 or null`;
      }
      const e = r.e === undefined ? null : r.e;
      if (e !== null && !shortString(e, 64)) return `${rat}.e must be a string of at most 64`;
      rows.push({ t, c: r.c, e });
    }
    out.push({ obis: p.obis, name, cols, rows });
  }
  return out;
}

/**
 * Parse and check a READING body.
 * @returns {{ok:true, reading:{ret:number, values:Array, profiles:Array}} | {ok:false, error:string}}
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
  const profiles = parseProfiles(r.profiles);
  if (typeof profiles === 'string') return { ok: false, error: profiles };
  return { ok: true, reading: { ret: r.ret, values, profiles } };
}

module.exports = { parseReading };
