import { Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull, like, or, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { apiKeys, servers } from '../db/schema';
import { EventsService } from '../events/events.service';
import { SecretsService } from '../auth/secrets.service';
import { ConfigService } from '../config/config.service';

/**
 * Third-party API key storage (encrypted at rest) + validity testing. The
 * CurseForge key from .env is imported once on boot if none is stored.
 */
@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name);

  constructor(
    private readonly dbService: DbService,
    private readonly events: EventsService,
    private readonly secrets: SecretsService,
    private readonly config: ConfigService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  async getKey(provider: string): Promise<string | null> {
    const [row] = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.provider, provider))
      .limit(1);
    if (!row) return null;
    const key = this.secrets.tryDecrypt(row.keyCipher);
    if (key === null) {
      this.logger.warn(
        `stored ${provider} key cannot be decrypted (SESSION_SECRET changed) — re-enter it in Settings`,
      );
    }
    return key;
  }

  async setKey(
    provider: string,
    key: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<void> {
    await this.db
      .insert(apiKeys)
      .values({ provider, keyCipher: this.secrets.encrypt(key) })
      .onConflictDoUpdate({
        target: apiKeys.provider,
        set: {
          keyCipher: this.secrets.encrypt(key),
          addedAt: sql`(datetime('now'))`,
        },
      });
    this.events.recordEvent({
      actor,
      type: 'api-key-set',
      summary: `API key updated for ${provider}`,
    });

    // Containers bake the key into their env at create time — a rotated key
    // only reaches CurseForge servers after a recreate. Flag them.
    if (provider === 'curseforge') {
      const flagged = await this.db
        .update(servers)
        .set({ pendingRecreate: true })
        .where(
          and(
            isNull(servers.deletedAt),
            or(
              eq(servers.type, 'AUTO_CURSEFORGE'),
              // packwiz always gets CF_API_KEY injected (a pack may reference
              // CurseForge-hosted mods and there's no cheap way to know
              // ahead of time) — flag it for recreate on rotation too.
              eq(servers.type, 'PACKWIZ'),
              like(servers.envJson, '%CF_SLUG%'),
              like(servers.envJson, '%CURSEFORGE_FILES%'),
            ),
          ),
        )
        .returning({ id: servers.id });
      if (flagged.length > 0) {
        this.events.recordEvent({
          actor,
          type: 'api-key-set',
          summary: `${flagged.length} CurseForge server(s) flagged for recreate to pick up the new key`,
        });
      }
    }
  }

  async deleteKey(
    provider: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<void> {
    await this.db.delete(apiKeys).where(eq(apiKeys.provider, provider));
    this.events.recordEvent({
      actor,
      type: 'api-key-removed',
      summary: `API key removed for ${provider}`,
    });
  }

  async maskedKey(provider: string): Promise<string | null> {
    const key = await this.getKey(provider);
    if (!key) return null;
    return key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : '••••';
  }

  /** Live-test the CurseForge key against their games endpoint. */
  async testCurseForgeKey(
    key?: string | null,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const resolvedKey =
      key === undefined ? await this.getKey('curseforge') : key;
    if (!resolvedKey) return { ok: false, error: 'No key stored' };
    try {
      const res = await fetch(
        'https://api.curseforge.com/v1/games?index=0&pageSize=1',
        {
          headers: { 'x-api-key': resolvedKey, Accept: 'application/json' },
          signal: AbortSignal.timeout(10000),
        },
      );
      const ok = res.ok;
      await this.db
        .update(apiKeys)
        .set({ lastTestedAt: sql`(datetime('now'))`, lastTestOk: ok })
        .where(eq(apiKeys.provider, 'curseforge'));
      return ok
        ? { ok: true }
        : {
            ok: false,
            error: `CurseForge answered HTTP ${res.status} — check the key`,
          };
    } catch (err) {
      return {
        ok: false,
        error: `Could not reach CurseForge: ${(err as Error).message}`,
      };
    }
  }

  /** One-time import from .env so the user's key lands in the encrypted store. */
  async importFromEnvOnce(): Promise<void> {
    if (!this.config.cfApiKeySeed) return;
    const [existing] = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.provider, 'curseforge'))
      .limit(1);
    if (existing) return;
    await this.setKey(
      'curseforge',
      this.config.cfApiKeySeed.replace(/^'|'$/g, ''),
      { actor: 'system' },
    );
    this.logger.log(
      'imported CurseForge API key from .env into encrypted store',
    );
  }
}
