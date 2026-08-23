import type { Role } from './auth';

export interface ResourceDefaults {
  heapMb: number;
  containerMemoryMb: number;
  cpus: number;
  diskQuotaGb: number;
  quotaWarnPct: number;
  quotaCriticalPct: number;
}

/** `GET /api/settings`'s response body. */
export interface SettingsResponseData {
  ok: true;
  publicHost: string;
  curseforge: { masked: string | null };
  panel: { host: string; port: number };
  defaults: ResourceDefaults;
}

export interface Localization {
  timezone: string;
  country: string;
  locale: string;
  timezoneAuto: boolean;
  countryAuto: boolean;
  systemTimezone: string;
  systemCountry: string;
}

/** The user shape listed/managed by the admin-only `/api/users` routes. */
export interface PublicUser {
  id: string;
  username: string;
  role: Role;
  createdAt: string;
  totpEnabled: boolean;
}
