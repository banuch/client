// Formatting of times and values. Server times (epoch ms) are shown in the
// server's TIMEZONE so every viewer sees the same clock. Profile row times are
// the meter's local time as text and are shown as they are.
import { serverNow } from './api.js';

let timeZone = 'Asia/Kolkata';
let partsFormat = null;
const LOCALE = 'en-IN';

export function setTimeZone(value) {
  timeZone = value;
  partsFormat = null;
}

export function zoneLabel() {
  try {
    const part = new Intl.DateTimeFormat(LOCALE, { timeZone, timeZoneName: 'short' })
      .formatToParts(new Date()).find((p) => p.type === 'timeZoneName');
    return part ? part.value : timeZone;
  } catch {
    return timeZone;
  }
}

export const zoneName = () => timeZone;

function parts(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  partsFormat ||= new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  return Object.fromEntries(partsFormat.formatToParts(date).map((p) => [p.type, p.value]));
}

// 2026-10-28 10:15:24 (same order as the meter's own times)
export function dateTime(value) {
  const p = parts(value);
  return p ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}` : '—';
}

export function dateMinute(value) {
  const p = parts(value);
  return p ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` : '—';
}

export function dateOnly(value) {
  const p = parts(value);
  return p ? `${p.year}-${p.month}-${p.day}` : '—';
}

// Time of day when the value is from today, otherwise date and time.
export function shortTime(value) {
  const p = parts(value);
  if (!p) return '—';
  const today = parts(new Date(serverNow()));
  const time = `${p.hour}:${p.minute}:${p.second}`;
  return p.day === today.day && p.month === today.month && p.year === today.year ? time : `${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function clockTime(value) {
  const p = parts(value);
  return p ? `${p.hour}:${p.minute}:${p.second}` : '—';
}

export function durationText(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) {
    const minutes = Math.floor((s % 3600) / 60);
    return `${Math.floor(s / 3600)} h${minutes ? ` ${minutes} min` : ''}`;
  }
  const hours = Math.floor((s % 86400) / 3600);
  return `${Math.floor(s / 86400)} d${hours ? ` ${hours} h` : ''}`;
}

export function ago(value) {
  if (!value) return 'never';
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? 'never' : `${durationText(Math.max(0, (serverNow() - t) / 1000))} ago`;
}

// Profile range bounds: meter local time "YYYY-MM-DD hh:mm:ss" in the display zone.
export function meterTimeText(ms) {
  const p = parts(ms);
  return p ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}` : '';
}

// datetime-local input value (in the display zone) -> epoch ms
export function localInputToMs(value) {
  if (!value) return null;
  const [date, time = '00:00'] = value.split('T');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const p = parts(new Date(guess));
  const shown = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return guess - (shown - guess);
}

export function msToLocalInput(ms) {
  const p = parts(ms);
  return p ? `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` : '';
}

export function present(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

export function num(value, digits = 2) {
  if (!present(value)) return '—';
  return Number(value).toLocaleString(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export const int = (value) => num(value, 0);

// Numbers from the meter: integers as they are, others with up to `digits` decimals.
export function meterNum(value, digits = 3) {
  if (!present(value)) return '—';
  const n = Number(value);
  return Number.isInteger(n) ? n.toLocaleString(LOCALE) : n.toLocaleString(LOCALE, { maximumFractionDigits: digits });
}

export function withUnit(text, unit) {
  return text === '—' || !unit ? text : `${text} ${unit}`;
}

export function bytesText(n) {
  if (!present(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${num(n / 1024, 1)} KB`;
  return `${num(n / 1048576, 2)} MB`;
}

// Spread between the highest and lowest phase relative to their average, in
// percent; ignores missing and zero phases.
export function unbalance(values) {
  const loaded = values.filter(present).map(Number).filter((v) => v !== 0);
  if (loaded.length < 2) return null;
  const avg = loaded.reduce((s, v) => s + v, 0) / loaded.length;
  return ((Math.max(...loaded) - Math.min(...loaded)) / Math.abs(avg)) * 100;
}

export function average(values) {
  const loaded = values.filter(present).map(Number);
  return loaded.length ? loaded.reduce((s, v) => s + v, 0) / loaded.length : null;
}
