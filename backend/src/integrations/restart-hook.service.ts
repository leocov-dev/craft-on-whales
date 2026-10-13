import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DbService } from '../db/db.service';
import { integrations } from '../db/schema';
import type {
  RestartHookConfig,
  RestartHookKeyResult,
} from '../../../shared/types/integrations';

const KIND = 'restart-hook';
const KEY_PREFIX = 'cow_rst_';

interface StoredConfig {
  keyHash?: string;
  keyPrefix?: string;
}

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Inbound restart webhook. One key per server, scoped to that server's
 * restart endpoint only. Stored as a sha256 digest (never the raw key) — the
 * key is full-entropy random, so a fast hash is enough (same reasoning as
 * `ApiTokensService`; see API_TOKENS_NOTES.md). The raw key is returned once,
 * from `regenerateKey()`.
 */
@Injectable()
export class RestartHookService {
  constructor(private readonly dbService: DbService) {}

  private get db() {
    return this.dbService.db;
  }

  private async row(serverId: string) {
    const [r] = await this.db
      .select()
      .from(integrations)
      .where(
        and(eq(integrations.serverId, serverId), eq(integrations.kind, KIND)),
      )
      .limit(1);
    return r;
  }

  private parse(configJson: string | undefined): StoredConfig {
    try {
      return JSON.parse(configJson || '{}') as StoredConfig;
    } catch {
      return {};
    }
  }

  async getConfig(serverId: string): Promise<RestartHookConfig> {
    const r = await this.row(serverId);
    const cfg = this.parse(r?.configJson);
    return {
      enabled: Boolean(r?.enabled && cfg.keyHash),
      hasKey: Boolean(cfg.keyHash),
      keyPrefix: cfg.keyPrefix ?? null,
      path: `/api/hooks/servers/${serverId}/restart`,
    };
  }

  async setEnabled(
    serverId: string,
    enabled: boolean,
  ): Promise<RestartHookConfig> {
    const r = await this.row(serverId);
    const cfg = this.parse(r?.configJson);
    if (enabled && !cfg.keyHash) {
      // Enabling without a key would be a hook nobody can call.
      return this.getConfig(serverId);
    }
    await this.upsert(serverId, enabled, cfg);
    return this.getConfig(serverId);
  }

  /** Mints a new key (replacing any old one, which stops working at once) and enables the hook. */
  async regenerateKey(serverId: string): Promise<RestartHookKeyResult> {
    const key = KEY_PREFIX + randomBytes(32).toString('base64url');
    await this.upsert(serverId, true, {
      keyHash: hashKey(key),
      keyPrefix: key.slice(0, KEY_PREFIX.length + 4),
    });
    return { key, restartHook: await this.getConfig(serverId) };
  }

  async clear(serverId: string): Promise<RestartHookConfig> {
    await this.upsert(serverId, false, {});
    return this.getConfig(serverId);
  }

  /** True only if the hook is enabled for this server and `raw` is its key. */
  async verify(serverId: string, raw: string): Promise<boolean> {
    const r = await this.row(serverId);
    const cfg = this.parse(r?.configJson);
    if (!r?.enabled || !cfg.keyHash) return false;
    const a = Buffer.from(hashKey(raw), 'hex');
    const b = Buffer.from(cfg.keyHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async upsert(
    serverId: string,
    enabled: boolean,
    cfg: StoredConfig,
  ): Promise<void> {
    const configJson = JSON.stringify(cfg);
    await this.db
      .insert(integrations)
      .values({ serverId, kind: KIND, enabled, configJson })
      .onConflictDoUpdate({
        target: [integrations.serverId, integrations.kind],
        set: {
          enabled,
          configJson,
          updatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
        },
      });
  }
}
