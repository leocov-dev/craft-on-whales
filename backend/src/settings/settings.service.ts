import { BadRequestException, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { ConfigService } from '../config/config.service';
import type { ResourceDefaults } from '../config/resource-defaults.resolver';
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
  constructor(
    private readonly dbService: DbService,
    private readonly config: ConfigService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  async getStartingPort(): Promise<number> {
    if (this.config.hasStartingPortEnv) {
      return this.config.ports.gameStart;
    }
    const v = await this.get('starting_port', null);
    if (
      typeof v === 'number' &&
      Number.isInteger(v) &&
      v >= 1024 &&
      v <= 65535
    ) {
      return v;
    }
    return this.config.ports.gameStart;
  }

  async setStartingPort(port: number): Promise<number> {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new BadRequestException(
        'Starting port must be an integer between 1024 and 65535.',
      );
    }
    await this.set('starting_port', port);
    return port;
  }

  async get<T = unknown>(
    key: string,
    fallback: T | null = null,
  ): Promise<T | null> {
    const [row] = await this.db
      .select()
      .from(settings)
      .where(eq(settings.key, key))
      .limit(1);
    if (!row) return fallback;
    try {
      return JSON.parse(row.valueJson) as T;
    } catch {
      return fallback;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.db
      .insert(settings)
      .values({ key, valueJson: JSON.stringify(value) })
      .onConflictDoUpdate({
        target: settings.key,
        set: { valueJson: JSON.stringify(value) },
      });
  }

  async remove(key: string): Promise<void> {
    await this.db.delete(settings).where(eq(settings.key, key));
  }

  // ---------------------------------------------------------------------
  // Public host / domain: shown in connect addresses instead of the LAN IP.

  private normalizeHost(host: unknown): string {
    let h = (typeof host === 'string' ? host : '').trim();
    if (!h) return '';
    h = h
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '')
      .trim()
      .toLowerCase();
    const valid =
      /^[a-z0-9.-]{1,253}$/.test(h) &&
      !h.startsWith('.') &&
      !h.endsWith('.') &&
      !h.startsWith('-') &&
      !h.includes('..');
    if (!valid) {
      throw new BadRequestException(
        'Enter a valid domain or hostname, e.g. mc.example.com (no scheme, path or port).',
      );
    }
    return h;
  }

  async getPublicHost(): Promise<string> {
    const v = await this.get('public_host', '');
    return typeof v === 'string' ? v : '';
  }

  /** Store (or clear, when empty) the public host. Returns the normalized value. */
  async setPublicHost(host: unknown): Promise<string> {
    const clean = this.normalizeHost(host);
    if (clean) await this.set('public_host', clean);
    else await this.remove('public_host');
    return clean;
  }

  /** "host:port" using the configured public host, or null when none is set. */
  async publicAddress(port: number | string): Promise<string | null> {
    const h = await this.getPublicHost();
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
  async getTimezone(): Promise<string> {
    const v = await this.get('timezone', '');
    return typeof v === 'string' && v ? v : this.detectSystemTimezone();
  }

  /** Store (or clear, when blank/"auto") the time zone. Returns the effective value. */
  async setTimezone(tz: unknown): Promise<string> {
    const clean = (typeof tz === 'string' ? tz : '').trim();
    if (!clean || clean.toLowerCase() === 'auto') {
      await this.remove('timezone');
      return this.getTimezone();
    }
    if (!this.isValidTimezone(clean)) {
      throw new BadRequestException(
        `Unknown time zone "${clean}". Use an IANA name like "America/New_York" or "Europe/Paris".`,
      );
    }
    await this.set('timezone', clean);
    return clean;
  }

  /** Effective country: the stored value, else the detected host country. */
  async getCountry(): Promise<string> {
    const v = await this.get('country', '');
    return typeof v === 'string' && v ? v : this.detectSystemCountry();
  }

  /** Store (or clear, when blank/"auto") the country. Returns the effective value. */
  async setCountry(cc: unknown): Promise<string> {
    const clean = (typeof cc === 'string' ? cc : '').trim().toUpperCase();
    if (!clean || clean === 'AUTO') {
      await this.remove('country');
      return this.getCountry();
    }
    if (!this.isValidCountry(clean)) {
      throw new BadRequestException(
        'Country must be a 2-letter ISO code, e.g. US, GB, DE.',
      );
    }
    await this.set('country', clean);
    return clean;
  }

  /** A BCP-47 locale for date/number formatting, from host language + chosen country. */
  async resolveLocale(): Promise<string> {
    let sysLoc = 'en-US';
    try {
      sysLoc = Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
    } catch {
      /* keep default */
    }
    const lang = sysLoc.split('-')[0] || 'en';
    const country = await this.getCountry();
    return country ? `${lang}-${country}` : sysLoc;
  }

  /** Everything the UI needs to render + edit localization. */
  async localization(): Promise<Localization> {
    const storedTz = await this.get('timezone', '');
    const storedCc = await this.get('country', '');
    return {
      timezone: await this.getTimezone(),
      country: await this.getCountry(),
      locale: await this.resolveLocale(),
      timezoneAuto: !storedTz,
      countryAuto: !storedCc,
      systemTimezone: this.detectSystemTimezone(),
      systemCountry: this.detectSystemCountry(),
    };
  }

  /** Slim object exposed to the browser for client-side formatting. */
  async clientLocalization(): Promise<{ timezone: string; locale: string }> {
    return {
      timezone: await this.getTimezone(),
      locale: await this.resolveLocale(),
    };
  }

  // ---------------------------------------------------------------------
  // Defaults for new servers: an admin can override a subset of
  // `ConfigService.defaults` (itself env/host-derived via
  // `ResourceDefaultsResolver`) so the create-wizard and API-create fallback
  // pre-fill from a panel-wide choice instead of always re-deriving from
  // .env/host memory. Overrides are stored as a partial patch under one key
  // and layered on top of the resolved base at read time — see
  // SETTINGS_NOTES.md for the full design writeup.

  private static readonly SERVER_DEFAULTS_KEY = 'server_creation_defaults';

  private static readonly SERVER_DEFAULTS_FIELDS = [
    'heapMb',
    'containerMemoryMb',
    'cpus',
    'diskQuotaGb',
    'quotaWarnPct',
    'quotaCriticalPct',
  ] as const;

  // Mirrors the bounds already enforced on these fields elsewhere (server
  // create/patch schemas in `api/servers.controller.ts`, blueprint resource
  // schema in `blueprints/blueprints.types.ts`) so a saved default can never
  // produce a value those endpoints would themselves reject.
  private static readonly SERVER_DEFAULTS_CLAMPS: Record<
    (typeof SettingsService.SERVER_DEFAULTS_FIELDS)[number],
    [number, number]
  > = {
    heapMb: [512, 262144],
    containerMemoryMb: [1024, 524288],
    cpus: [0, 128],
    diskQuotaGb: [0, 16384],
    quotaWarnPct: [0, 99],
    quotaCriticalPct: [1, 100],
  };

  /** Sanitizes an incoming patch to known fields, clamped to sane bounds. Unknown/invalid keys are dropped, not rejected — a partial save should never fail because of one bad field. */
  private sanitizeDefaultsPatch(
    patch: Record<string, unknown>,
  ): Partial<ResourceDefaults> {
    const out: Partial<ResourceDefaults> = {};
    for (const key of SettingsService.SERVER_DEFAULTS_FIELDS) {
      const raw = patch[key];
      if (raw === undefined || raw === null) continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      const [min, max] = SettingsService.SERVER_DEFAULTS_CLAMPS[key];
      const clamped = Math.min(max, Math.max(min, n));
      out[key] = key === 'cpus' ? clamped : Math.round(clamped);
    }
    return out;
  }

  /** The effective server-creation defaults: `config.defaults` layered with any saved admin overrides. */
  async getEffectiveDefaults(): Promise<ResourceDefaults> {
    const overrides = await this.get<Partial<ResourceDefaults>>(
      SettingsService.SERVER_DEFAULTS_KEY,
      {},
    );
    return { ...this.config.defaults, ...(overrides ?? {}) };
  }

  /** Persist a partial admin override, layered onto any existing one. Returns the new effective defaults. */
  async setServerDefaults(
    patch: Record<string, unknown>,
  ): Promise<ResourceDefaults> {
    const existing =
      (await this.get<Partial<ResourceDefaults>>(
        SettingsService.SERVER_DEFAULTS_KEY,
        {},
      )) ?? {};
    const merged = { ...existing, ...this.sanitizeDefaultsPatch(patch) };
    await this.set(SettingsService.SERVER_DEFAULTS_KEY, merged);
    return this.getEffectiveDefaults();
  }

  /** Clears every saved override — back to `config.defaults`. Returns the new effective defaults. */
  async resetServerDefaults(): Promise<ResourceDefaults> {
    await this.remove(SettingsService.SERVER_DEFAULTS_KEY);
    return this.getEffectiveDefaults();
  }
}
