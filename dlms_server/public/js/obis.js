// OBIS codes the page gives meaning to (names as in firmware/obis_names.h,
// IS 15959). Values arrive scaled with their unit (kW, kWh, V, A, ...).

export const O = {
  serial: '0.0.96.1.0.255',
  manufacturer: '0.0.96.1.1.255',
  deviceType: '0.0.96.1.2.255',
  hwVersion: '0.0.96.1.3.255',
  year: '0.0.96.1.4.255',
  meterFw: '1.0.0.2.0.255',
  meterType: '0.0.94.91.9.255',
  category: '0.0.94.91.11.255',
  currentRating: '0.0.94.91.12.255',
  clock: '0.0.1.0.0.255',
  ctRatio: '1.0.0.4.2.255',
  ptRatio: '1.0.0.4.3.255',
  demandPeriod: '1.0.0.8.0.255',
  profilePeriod: '1.0.0.8.4.255',
  dailyPeriod: '1.0.0.8.5.255',
  // instantaneous
  vR: '1.0.32.7.0.255', vY: '1.0.52.7.0.255', vB: '1.0.72.7.0.255', v: '1.0.12.7.0.255',
  iR: '1.0.31.7.0.255', iY: '1.0.51.7.0.255', iB: '1.0.71.7.0.255', i: '1.0.11.7.0.255', iN: '1.0.91.7.0.255',
  pfR: '1.0.33.7.0.255', pfY: '1.0.53.7.0.255', pfB: '1.0.73.7.0.255', pf: '1.0.13.7.0.255',
  kwR: '1.0.21.7.0.255', kwY: '1.0.41.7.0.255', kwB: '1.0.61.7.0.255',
  kvarR: '1.0.23.7.0.255', kvarY: '1.0.43.7.0.255', kvarB: '1.0.63.7.0.255',
  freq: '1.0.14.7.0.255',
  kw: '1.0.1.7.0.255', kwExport: '1.0.2.7.0.255', kvar: '1.0.3.7.0.255', kva: '1.0.9.7.0.255',
  // energy
  kwh: '1.0.1.8.0.255', kwhExport: '1.0.2.8.0.255',
  kvarhLag: '1.0.5.8.0.255', kvarhLead: '1.0.8.8.0.255',
  kvah: '1.0.9.8.0.255', kvahExport: '1.0.10.8.0.255',
  // demand
  mdKw: '1.0.1.6.0.255', mdKva: '1.0.9.6.0.255', mdKwExport: '1.0.2.6.0.255', mdKvaExport: '1.0.10.6.0.255',
  cumMdKw: '1.0.1.2.0.255', cumMdKva: '1.0.9.2.0.255',
  // counters
  powerFailures: '0.0.96.7.0.255', tamperCount: '0.0.94.91.0.255', billingCount: '0.0.0.1.0.255',
  programmingCount: '0.0.96.2.0.255', billingDate: '0.0.0.1.2.255',
  powerOffDuration: '0.0.94.91.8.255', powerOnDuration: '0.0.94.91.14.255',
};

export const PROFILE = {
  instantaneous: '1.0.94.91.0.255',
  block: '1.0.99.1.0.255',
  daily: '1.0.99.2.0.255',
  billing: '1.0.98.1.0.255',
  nameplate: '0.0.94.91.10.255',
};

// Event log profiles 0.0.99.98.x.255 -> category
export const EVENT_CATEGORIES = [
  ['0.0.99.98.0.255', 'voltage', 'Voltage'],
  ['0.0.99.98.1.255', 'current', 'Current'],
  ['0.0.99.98.2.255', 'power', 'Power'],
  ['0.0.99.98.3.255', 'transaction', 'Transaction'],
  ['0.0.99.98.4.255', 'other', 'Other'],
  ['0.0.99.98.5.255', 'non-roll', 'Non-roll over'],
  ['0.0.99.98.6.255', 'control', 'Control'],
];

export const tozKwh = (n) => `1.0.1.8.${n}.255`;
export const tozKvah = (n) => `1.0.9.8.${n}.255`;
// Codes a zone value may be under, standard first. Secure meters keep their
// zones under 1.0.129.8.n (kWh) and 1.0.137.8.n (kVAh) instead.
export const tozKwhCodes = (n) => [tozKwh(n), `1.0.129.8.${n}.255`];
export const tozKvahCodes = (n) => [tozKvah(n), `1.0.137.8.${n}.255`];

// Latest reading values by OBIS code.
export function valueMap(values) {
  return new Map((values || []).map((v) => [v.obis, v]));
}

export const numOf = (map, obis) => {
  const v = map.get(obis);
  return v && v.num !== null ? v.num : null;
};
export const unitOf = (map, obis, dflt = '') => map.get(obis)?.unit || dflt;
export function textOf(map, obis) {
  const v = map.get(obis);
  if (!v) return null;
  return v.num !== null ? String(v.num) : v.text;
}
