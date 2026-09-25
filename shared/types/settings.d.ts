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
  /** Effective server-creation defaults: `defaultsBase` with any admin overrides layered on. */
  defaults: ResourceDefaults;
  /** The built-in/env/host-derived defaults, before any admin override — what "Restore built-ins" resets to. */
  defaultsBase: ResourceDefaults;
  startingPort?: number;
  startingPortOverriddenByEnv?: boolean;
}

/** `GET`/`POST /api/settings/defaults`'s response body. */
export interface ServerDefaultsResponseData {
  ok: true;
  defaults: ResourceDefaults;
  base: ResourceDefaults;
}

/**
 * Panel-wide backup retention ceilings, layered on top of the fixed
 * per-reason count buckets (`BackupsService.RETENTION_BUCKETS`). `0` means
 * "no limit" for either field.
 */
export interface BackupRetentionCeilings {
  maxAgeDays: number;
  maxTotalGb: number;
}

/** `GET`/`POST /api/settings/backup-retention`'s response body. */
export interface BackupRetentionResponseData {
  ok: true;
  ceilings: BackupRetentionCeilings;
}

/**
 * Panel self-update check result: the running panel version compared against
 * the newest published GitHub Release of this repo. Read-only — there is no
 * apply/self-update mechanism anywhere in this codebase.
 */
export interface PanelUpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  releaseName: string | null;
  releaseUrl: string | null;
  publishedAt: string | null;
  checkedAt: string | null;
  updateAvailable: boolean;
  /** Set when the most recent GitHub lookup failed; other fields still hold the last known-good result, if any. */
  error: string | null;
}

/** `GET /api/settings/panel-update`'s response body. */
export interface PanelUpdateResponseData {
  ok: true;
  update: PanelUpdateStatus;
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
