// REST API access (see src/http-server.js). Errors become short readable
// messages; ages are measured against the server clock, not the browser's.

let clockSkewMs = 0;

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function friendlyMessage(status, code) {
  if (status === 401) return 'Login required. Reload the page to log in again.';
  if (status === 404) return code === 'unknown_device' ? 'This device has never sent data to this server.' : 'Not found.';
  if (status === 429) return 'Too many failed logins from this address. Try again later.';
  if (status === 400) return `The request was not valid (${code}).`;
  return `The server returned an error (${status}).`;
}

export async function api(path, { signal, text = false } = {}) {
  let res;
  try {
    res = await fetch(path, { headers: { Accept: text ? 'text/plain' : 'application/json' }, signal });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('The server cannot be reached. Check the network connection.', 0);
  }
  const date = res.headers.get('Date');
  if (date) clockSkewMs = new Date(date).getTime() - Date.now();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(friendlyMessage(res.status, body.error), res.status);
  }
  return text ? { text: await res.text(), headers: res.headers } : res.json();
}

export function serverNow() {
  return Date.now() + clockSkewMs;
}

export function query(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== '' && value !== null && value !== undefined) params.set(key, value);
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

export function devicePath(id, suffix = '') {
  return `/api/devices/${encodeURIComponent(id)}${suffix}`;
}

export const isAbort = (error) => error?.name === 'AbortError';
