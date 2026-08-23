import { BadRequestException, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { settings } from '../db/schema';

export interface Localization {
  timezone: string;
  country: string;
  locale: string;
  timezoneAuto: boolean;
  countryAuto: boolean;
  systemTimezone: string;
  systemCountry: string;
}

/**
 * Panel-wide key/value settings (non-secret) stored in the `settings` table
 * as JSON values. Secrets (API keys, RCON passwords) live in api_keys/servers,
 * encrypted — never here.
 */
@Injectable()
export class SettingsService {
  constructor(private readonly dbService: DbService) {}

  private get db() {
    return this.dbService.db;
  }

  get(key: string, fallback: unknown = null): unknown {
    const row = this.db.select().from(settings).where(eq(settings.key, key)).get();
    if (!row) return fallback;
    try {
      return JSON.parse(row.valueJson);
    } catch {
      return fallback;
    }
  }

  set(key: string, value: unknown): void {
    this.db
      .insert(settings)
      .values({ key, valueJson: JSON.stringify(value) })
      .onConflictDoUpdate({ target: settings.key, set: { valueJson: JSON.stringify(value) } })
      .run();
  }

  remove(key: string): void {
    this.db.delete(settings).where(eq(settings.key, key)).run();
  }

  // ---------------------------------------------------------------------
  // Public host / domain: shown in connect addresses instead of the LAN IP.

  private normalizeHost(host: unknown): string {
    let h = String(host || '').trim();
    if (!h) return '';
    h = h
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '')
      .trim()
      .toLowerCase();
    const valid =
      /^[a-z0-9.-]{1,253}$/.test(h) && !h.startsWith('.') && !h.endsWith('.') && !h.startsWith('-') && !h.includes('..');
    if (!valid) {
      throw new BadRequestException('Enter a valid domain or hostname, e.g. mc.example.com (no scheme, path or port).');
    }
    return h;
  }

  getPublicHost(): string {
    const v = this.get('public_host', '');
    return typeof v === 'string' ? v : '';
  }

  /** Store (or clear, when empty) the public host. Returns the normalized value. */
  setPublicHost(host: unknown): string {
    const clean = this.normalizeHost(host);
    if (clean) this.set('public_host', clean);
    else this.remove('public_host');
    return clean;
  }

  /** "host:port" using the configured public host, or null when none is set. */
  publicAddress(port: number | string): string | null {
    const h = this.getPublicHost();
    return h ? `${h}:${port}` : null;
  }

  // ---------------------------------------------------------------------
  // Localization: timezone + country. Both default to "auto" — detected from
  // the host OS via Intl.

  detectSystemTimezone(): string {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }

  detectSystemCountry(): string {
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

  isValidTimezone(tz: unknown): boolean {
    if (!tz || typeof tz !== 'string') return false;
    try {
      Intl.DateTimeFormat('en-US', { timeZone: tz }).format();
      return true;
    } catch {
      return false;
    }
  }

  isValidCountry(cc: unknown): boolean {
    return typeof cc === 'string' && /^[A-Za-z]{2}$/.test(cc);
  }

  /** Effective time zone: the stored value, else the detected host zone. */
  getTimezone(): string {
    const v = this.get('timezone', '');
    return typeof v === 'string' && v ? v : this.detectSystemTimezone();
  }

  /** Store (or clear, when blank/"auto") the time zone. Returns the effective value. */
  setTimezone(tz: unknown): string {
    const clean = String(tz || '').trim();
    if (!clean || clean.toLowerCase() === 'auto') {
      this.remove('timezone');
      return this.getTimezone();
    }
    if (!this.isValidTimezone(clean)) {
      throw new BadRequestException(`Unknown time zone "${clean}". Use an IANA name like "America/New_York" or "Europe/Paris".`);
    }
    this.set('timezone', clean);
    return clean;
  }

  /** Effective country: the stored value, else the detected host country. */
  getCountry(): string {
    const v = this.get('country', '');
    return typeof v === 'string' && v ? v : this.detectSystemCountry();
  }

  /** Store (or clear, when blank/"auto") the country. Returns the effective value. */
  setCountry(cc: unknown): string {
    const clean = String(cc || '').trim().toUpperCase();
    if (!clean || clean === 'AUTO') {
      this.remove('country');
      return this.getCountry();
    }
    if (!this.isValidCountry(clean)) {
      throw new BadRequestException('Country must be a 2-letter ISO code, e.g. US, GB, DE.');
    }
    this.set('country', clean);
    return clean;
  }

  /** A BCP-47 locale for date/number formatting, from host language + chosen country. */
  resolveLocale(): string {
    let sysLoc = 'en-US';
    try {
      sysLoc = Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
    } catch {
      /* keep default */
    }
    const lang = sysLoc.split('-')[0] || 'en';
    const country = this.getCountry();
    return country ? `${lang}-${country}` : sysLoc;
  }

  /** Everything the UI needs to render + edit localization. */
  localization(): Localization {
    const storedTz = this.get('timezone', '');
    const storedCc = this.get('country', '');
    return {
      timezone: this.getTimezone(),
      country: this.getCountry(),
      locale: this.resolveLocale(),
      timezoneAuto: !storedTz,
      countryAuto: !storedCc,
      systemTimezone: this.detectSystemTimezone(),
      systemCountry: this.detectSystemCountry(),
    };
  }

  /** Slim object exposed to the browser for client-side formatting. */
  clientLocalization(): { timezone: string; locale: string } {
    return { timezone: this.getTimezone(), locale: this.resolveLocale() };
  }
}
