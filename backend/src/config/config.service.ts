import { Injectable } from '@nestjs/common';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

const MB = 1024 * 1024;

export type TrustProxy = boolean | number | string;
export type CookieSecure = boolean | 'auto';
export type DbDriver = 'sqlite' | 'postgres';

export interface ResourceDefaults {
  heapMb: number;
  containerMemoryMb: number;
  cpus: number;
  diskQuotaGb: number;
  quotaWarnPct: number;
  quotaCriticalPct: number;
}

/**
 * Central panel configuration — a straight port of src/config/index.ts's
 * resolver functions. The one behavioral change: the session-secret file
 * write moves out of *import*-time (a Nest anti-pattern — top-level code
 * running merely by `require()`-ing the module) into the constructor of a
 * DI-managed `@Injectable()`, which Nest instantiates deliberately rather
 * than as a side effect of importing the file. It stays in the constructor
 * rather than `onModuleInit` so every field is available synchronously right
 * after construction — main.ts needs `sessionSecret` to wire up
 * express-session's middleware *before* `app.init()` mounts Nest's router
 * (middleware registered after `init()` runs after routing in the Express
 * stack, so session data wouldn't be populated yet when guards/controllers run).
 */
@Injectable()
export class ConfigService {
  readonly root: string;
  readonly dataDir: string;
  readonly dataDirHost: string;
  readonly host: string;
  readonly port: number;
  readonly isExposedBind: boolean;
  readonly sessionSecret: string;
  readonly cfApiKeySeed: string;
  readonly trustProxy: TrustProxy;
  readonly cookieSecure: CookieSecure;
  readonly mapProxyHost: string;
  readonly mcImageRepo: string;
  readonly mcRouterImage: string;
  readonly ports: {
    gameStart: number;
    rconOffset: number;
    bedrockStart: number;
  };
  readonly defaults: ResourceDefaults;
  readonly dbDriver: DbDriver;
  readonly databaseUrl: string | undefined;

  constructor() {
    // backend/ is one level deeper than src/ was (repo/backend/dist vs
    // repo/src) — DATA_DIR still defaults to ./data at the repo root so an
    // existing install's data directory keeps working unmodified.
    this.root = path.resolve(__dirname, '..', '..', '..');
    this.dataDir = path.resolve(this.root, process.env.DATA_DIR || './data');
    this.host = process.env.PANEL_HOST || '127.0.0.1';
    this.port = this.numFromEnv('PANEL_PORT', 3000, { min: 1, max: 65535 });
    this.isExposedBind =
      this.host !== '127.0.0.1' &&
      this.host !== 'localhost' &&
      this.host !== '::1';
    this.cfApiKeySeed = process.env.CF_API_KEY || '';
    this.trustProxy = this.resolveTrustProxy();
    this.cookieSecure = this.resolveCookieSecure();
    this.mcImageRepo = (
      process.env.MC_IMAGE_REPO || 'itzg/minecraft-server'
    ).trim();
    this.mcRouterImage = (
      process.env.MC_ROUTER_IMAGE || 'itzg/mc-router:latest'
    ).trim();
    this.ports = {
      gameStart: this.numFromEnv('PORT_GAME_START', 25565, {
        min: 1,
        max: 65535,
      }),
      rconOffset: this.numFromEnv('PORT_RCON_OFFSET', 1000, {
        min: 1,
        max: 64000,
      }),
      bedrockStart: this.numFromEnv('PORT_BEDROCK_START', 19132, {
        min: 1,
        max: 65535,
      }),
    };
    this.defaults = this.resolveDefaults();
    this.dbDriver = this.resolveDbDriver();
    this.databaseUrl = process.env.DATABASE_URL?.trim() || undefined;
    if (this.dbDriver === 'postgres' && !this.databaseUrl) {
      throw new Error(
        'DB_DRIVER=postgres requires DATABASE_URL to be set (e.g. postgres://user:pass@host:5432/panel).',
      );
    }
    this.dataDirHost = this.resolveDataDirHost();
    this.mapProxyHost = this.resolveMapProxyHost();
    this.sessionSecret = this.resolveSessionSecret();
    if (!this.sessionSecret || this.sessionSecret.length < 16) {
      throw new Error('Failed to resolve a session secret.');
    }
  }

  private numFromEnv(
    name: string,
    fallback: number,
    { min = 0, max = Number.MAX_SAFE_INTEGER } = {},
  ): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
      throw new Error(
        `${name} must be an integer between ${min} and ${max} — got "${raw}". Fix it in your .env (or leave it blank for the default ${fallback}).`,
      );
    }
    return n;
  }

  private resolveSessionSecret(): string {
    const fromEnv = process.env.SESSION_SECRET;
    if (fromEnv && fromEnv.trim().length > 0) {
      if (fromEnv.trim().length < 16) {
        throw new Error(
          'SESSION_SECRET is set but too short — use at least 16 characters (e.g. `openssl rand -base64 48`).',
        );
      }
      return fromEnv.trim();
    }
    const secretFile = path.join(this.dataDir, '.session-secret');
    try {
      const existing = fs.readFileSync(secretFile, 'utf8').trim();
      if (existing.length >= 16) return existing;
    } catch {
      /* not created yet — fall through and generate */
    }
    const generated = crypto.randomBytes(48).toString('base64url');
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(secretFile, generated, { mode: 0o600 });
      // eslint-disable-next-line no-console
      console.log(
        `No SESSION_SECRET set — generated one and saved it to ${secretFile} (keep it private; delete it to rotate).`,
      );
    } catch (err) {
      throw new Error(
        `Could not persist a generated session secret to ${secretFile}: ${(err as Error).message}`,
      );
    }
    return generated;
  }

  private resolveDefaults(): ResourceDefaults {
    const envHeap = this.numFromEnv('DEFAULT_HEAP_MB', 0, {
      min: 0,
      max: 1024 * 1024,
    });
    const envContainer = this.numFromEnv('DEFAULT_CONTAINER_MEMORY_MB', 0, {
      min: 0,
      max: 1024 * 1024,
    });
    const envQuota = this.numFromEnv('DEFAULT_DISK_QUOTA_GB', 0, {
      min: 0,
      max: 1024 * 1024,
    });
    const hostMb = os.totalmem() / MB;
    const autoHeap = Math.min(
      8192,
      Math.max(1024, Math.round((hostMb * 0.25) / 512) * 512),
    );
    const heapMb = envHeap || autoHeap;
    const containerMemoryMb =
      envContainer || Math.round((heapMb * 1.5) / 512) * 512;
    return {
      heapMb,
      containerMemoryMb,
      cpus: 0,
      diskQuotaGb: envQuota || 25,
      quotaWarnPct: 80,
      quotaCriticalPct: 95,
    };
  }

  private resolveDbDriver(): DbDriver {
    const raw = (process.env.DB_DRIVER || 'sqlite').trim();
    if (raw === 'sqlite' || raw === 'postgres') return raw;
    throw new Error(`DB_DRIVER must be "sqlite" or "postgres" — got "${raw}".`);
  }

  private resolveTrustProxy(): TrustProxy {
    const raw = (process.env.TRUST_PROXY || '').trim();
    if (!raw) return false;
    if (/^\d+$/.test(raw)) return Number(raw);
    if (raw.toLowerCase() === 'true') return true;
    if (raw.toLowerCase() === 'false') return false;
    return raw;
  }

  private resolveCookieSecure(): CookieSecure {
    const raw = (process.env.COOKIE_SECURE || '').trim().toLowerCase();
    if (raw === 'true') return true;
    if (raw === 'auto') return 'auto';
    return false;
  }

  private resolveDataDirHost(): string {
    const raw = (process.env.DATA_DIR_HOST || '').trim();
    if (!raw) return this.dataDir;
    const isAbsolute = raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw);
    if (!isAbsolute) {
      throw new Error(
        `DATA_DIR_HOST must be an absolute host path (e.g. /opt/msm/data or C:\\msm\\data) — got "${raw}".`,
      );
    }
    const trimmed = raw.replace(/[\\/]+$/, '');
    return trimmed === '' ? '/' : trimmed;
  }

  private resolveMapProxyHost(): string {
    const raw = (process.env.MAP_PROXY_HOST || '').trim();
    if (raw) return raw;
    return this.resolveDataDirHost() === this.dataDir
      ? '127.0.0.1'
      : 'host.docker.internal';
  }
}
