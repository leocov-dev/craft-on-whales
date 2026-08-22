'use strict';

// Panel-wide key/value settings (non-secret) stored in the `settings` table as
// JSON values. Secrets (API keys, RCON passwords) live in api_keys/servers,
// encrypted — never here.

const db = require('../db') as typeof import('../db');

function get(key: string, fallback: unknown = null): unknown {
  const row = db.get('SELECT value_json FROM settings WHERE key = ?', key);
  if (!row) return fallback;
  try {
    return JSON.parse(String(row.value_json));
  } catch {
    return fallback;
  }
}

function set(key: string, value: unknown): void {
  db.run(
    `INSERT INTO settings (key, value_json) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    key,
    JSON.stringify(value)
  );
}

function remove(key: string): void {
  db.run('DELETE FROM settings WHERE key = ?', key);
}

// ---------------------------------------------------------------------------
// Public host / domain: shown in connect addresses instead of the LAN IP, so
// players can be handed "mc.example.com:25565" instead of a raw IP. Optional.

function normalizeHost(host: unknown): string {
  let h = String(host || '').trim();
  if (!h) return '';
  h = h
    .replace(/^https?:\/\//i, '') // tolerate a pasted URL
    .replace(/\/.*$/, '') // drop any path
    .replace(/:\d+$/, '') // drop a trailing :port (the game port is appended per server)
    .trim()
    .toLowerCase();
  const valid =
    /^[a-z0-9.-]{1,253}$/.test(h) && !h.startsWith('.') && !h.endsWith('.') && !h.startsWith('-') && !h.includes('..');
  if (!valid) {
    const err: Error & { status?: number } = new Error(
      'Enter a valid domain or hostname, e.g. mc.example.com (no scheme, path or port).'
    );
    err.status = 400;
    throw err;
  }
  return h;
}

function getPublicHost(): string {
  const v = get('public_host', '');
  return typeof v === 'string' ? v : '';
}

/** Store (or clear, when empty) the public host. Returns the normalized value. */
function setPublicHost(host: unknown): string {
  const clean = normalizeHost(host);
  if (clean) set('public_host', clean);
  else remove('public_host');
  return clean;
}

/** "host:port" using the configured public host, or null when none is set. */
function publicAddress(port: number | string): string | null {
  const h = getPublicHost();
  return h ? `${h}:${port}` : null;
}

// ---------------------------------------------------------------------------
// Localization: timezone + country. Both default to "auto" — detected from the
// host OS via Intl — so timelines and dates read in the operator's local time
// without any setup. Stored values (when set) override the detection.

/** The host's IANA time zone (e.g. "America/New_York"), or UTC if undetectable. */
function detectSystemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Best-effort ISO-3166 alpha-2 country from the host locale (e.g. "US"). */
function detectSystemCountry(): string {
  try {
    const loc = Intl.DateTimeFormat().resolvedOptions().locale || '';
    const m = /-([A-Za-z]{2})\b/.exec(loc);
    if (m?.[1]) return m[1].toUpperCase();
    const region = new Intl.Locale(loc).maximize().region;
    return region ? region.toUpperCase() : '';
  } catch {
    return '';
  }
}

function isValidTimezone(tz: unknown): boolean {
  if (!tz || typeof tz !== 'string') return false;
  try {
    // Resolving a formatter throws RangeError for an unknown zone.
    Intl.DateTimeFormat('en-US', { timeZone: tz }).format();
    return true;
  } catch {
    return false;
  }
}

function isValidCountry(cc: unknown): boolean {
  return typeof cc === 'string' && /^[A-Za-z]{2}$/.test(cc);
}

/** Effective time zone: the stored value, else the detected host zone. */
function getTimezone(): string {
  const v = get('timezone', '');
  return typeof v === 'string' && v ? v : detectSystemTimezone();
}

/** Store (or clear, when blank/"auto") the time zone. Returns the effective value. */
function setTimezone(tz: unknown): string {
  const clean = String(tz || '').trim();
  if (!clean || clean.toLowerCase() === 'auto') {
    remove('timezone');
    return getTimezone();
  }
  if (!isValidTimezone(clean)) {
    const err: Error & { status?: number } = new Error(
      `Unknown time zone "${clean}". Use an IANA name like "America/New_York" or "Europe/Paris".`
    );
    err.status = 400;
    throw err;
  }
  set('timezone', clean);
  return clean;
}

/** Effective country: the stored value, else the detected host country. */
function getCountry(): string {
  const v = get('country', '');
  return typeof v === 'string' && v ? v : detectSystemCountry();
}

/** Store (or clear, when blank/"auto") the country. Returns the effective value. */
function setCountry(cc: unknown): string {
  const clean = String(cc || '')
    .trim()
    .toUpperCase();
  if (!clean || clean === 'AUTO') {
    remove('country');
    return getCountry();
  }
  if (!isValidCountry(clean)) {
    const err: Error & { status?: number } = new Error('Country must be a 2-letter ISO code, e.g. US, GB, DE.');
    err.status = 400;
    throw err;
  }
  set('country', clean);
  return clean;
}

/** A BCP-47 locale for date/number formatting, from host language + chosen country. */
function resolveLocale(): string {
  let sysLoc = 'en-US';
  try {
    sysLoc = Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
  } catch {
    /* keep default */
  }
  const lang = sysLoc.split('-')[0] || 'en';
  const country = getCountry();
  return country ? `${lang}-${country}` : sysLoc;
}

interface Localization {
  timezone: string;
  country: string;
  locale: string;
  timezoneAuto: boolean;
  countryAuto: boolean;
  systemTimezone: string;
  systemCountry: string;
}

/** Everything the UI needs to render + edit localization. */
function localization(): Localization {
  const storedTz = get('timezone', '');
  const storedCc = get('country', '');
  return {
    timezone: getTimezone(),
    country: getCountry(),
    locale: resolveLocale(),
    timezoneAuto: !storedTz,
    countryAuto: !storedCc,
    systemTimezone: detectSystemTimezone(),
    systemCountry: detectSystemCountry(),
  };
}

/** Slim object exposed to the browser (window.MSM) for client-side formatting. */
function clientLocalization(): { timezone: string; locale: string } {
  return { timezone: getTimezone(), locale: resolveLocale() };
}

export = {
  get,
  set,
  remove,
  getPublicHost,
  setPublicHost,
  publicAddress,
  normalizeHost,
  getTimezone,
  setTimezone,
  getCountry,
  setCountry,
  resolveLocale,
  detectSystemTimezone,
  detectSystemCountry,
  isValidTimezone,
  isValidCountry,
  localization,
  clientLocalization,
};
