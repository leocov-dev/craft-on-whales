import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { eq, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { DbService } from '../db/db.service';
import { apiTokens, servers } from '../db/schema';
import { SettingsService } from '../settings/settings.service';
import { EventsService } from '../events/events.service';

const SETTINGS_KEY = 'public_api_enabled';
const TOKEN_PREFIX = 'cow_pat_'; // "public api token" — distinguishes it in logs/UI at a glance

export interface ApiTokenSummary {
  id: string;
  label: string;
  createdBy: string;
  serverIds: string[] | null; // null = all servers
  expiresAt: string | null;
  revoked: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ResolvedApiToken {
  id: string;
  label: string;
  serverIds: string[] | null;
}

function parseServerIds(json: string | null): string[] | null {
  if (json == null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed))
      return parsed.filter((v) => typeof v === 'string');
  } catch {
    // fall through
  }
  return [];
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function rowToSummary(row: typeof apiTokens.$inferSelect): ApiTokenSummary {
  return {
    id: row.id,
    label: row.label,
    createdBy: row.createdBy,
    serverIds: parseServerIds(row.serverIdsJson ?? null),
    expiresAt: row.expiresAt ?? null,
    revoked: row.revoked,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt ?? null,
  };
}

/**
 * Admin-minted Bearer tokens behind the public read-only API
 * (`/api/v1/*`). See API_TOKENS_NOTES.md for the full design writeup
 * (hashing, scoping, off-by-default toggle, rate limiting).
 */
@Injectable()
export class ApiTokensService {
  constructor(
    private readonly dbService: DbService,
    private readonly settings: SettingsService,
    private readonly events: EventsService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  async isEnabled(): Promise<boolean> {
    return Boolean(await this.settings.get<boolean>(SETTINGS_KEY, false));
  }

  async setEnabled(
    enabled: boolean,
    opts: { actor: string },
  ): Promise<boolean> {
    await this.settings.set(SETTINGS_KEY, Boolean(enabled));
    this.events.recordEvent({
      actor: opts.actor,
      type: enabled ? 'public-api-enabled' : 'public-api-disabled',
      summary: enabled
        ? 'Public API enabled.'
        : 'Public API disabled — existing tokens can no longer authenticate.',
    });
    return Boolean(enabled);
  }

  async list(): Promise<ApiTokenSummary[]> {
    const rows = await this.db.select().from(apiTokens);
    return rows
      .map(rowToSummary)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Mints a new token and returns the raw value once — it is never
   * retrievable again, only its metadata via `list()`.
   */
  async create(
    input: {
      label: string;
      serverIds: string[] | null;
      expiresAt: string | null;
    },
    opts: { actor: string },
  ): Promise<{ token: string; summary: ApiTokenSummary }> {
    const label = input.label.trim();
    if (!label) throw new BadRequestException('Label is required.');

    let serverIds: string[] | null = null;
    if (input.serverIds !== null) {
      if (!Array.isArray(input.serverIds) || input.serverIds.length === 0) {
        throw new BadRequestException(
          'Scope to at least one server, or leave unset for every server.',
        );
      }
      const rows = await this.db
        .select({ id: servers.id })
        .from(servers)
        .where(isNull(servers.deletedAt));
      const validIds = new Set(rows.map((r) => r.id));
      const unknown = input.serverIds.filter((id) => !validIds.has(id));
      if (unknown.length > 0) {
        throw new BadRequestException(
          `Unknown server id(s): ${unknown.join(', ')}`,
        );
      }
      serverIds = [...new Set(input.serverIds)];
    }

    let expiresAt: string | null = null;
    if (input.expiresAt) {
      const d = new Date(input.expiresAt);
      if (Number.isNaN(d.getTime())) {
        throw new BadRequestException('Invalid expiry date.');
      }
      if (d.getTime() <= Date.now()) {
        throw new BadRequestException('Expiry must be in the future.');
      }
      expiresAt = d.toISOString();
    }

    const raw = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const id = `apit_${nanoid(8)}`;
    await this.db.insert(apiTokens).values({
      id,
      tokenHash: hashToken(raw),
      label,
      createdBy: opts.actor,
      serverIdsJson: serverIds === null ? null : JSON.stringify(serverIds),
      expiresAt,
      revoked: false,
    });

    this.events.recordEvent({
      actor: opts.actor,
      type: 'api-token-created',
      summary: `Public API token "${label}" created.`,
      details: { tokenId: id, serverIds, expiresAt },
    });

    const [row] = await this.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.id, id))
      .limit(1);
    if (!row) throw new Error('Token vanished immediately after insert');
    return { token: raw, summary: rowToSummary(row) };
  }

  async revoke(id: string, opts: { actor: string }): Promise<void> {
    const [row] = await this.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.id, id))
      .limit(1);
    if (!row) throw new NotFoundException('Token not found.');
    if (row.revoked) throw new ConflictException('Token already revoked.');
    await this.db
      .update(apiTokens)
      .set({ revoked: true })
      .where(eq(apiTokens.id, id));
    this.events.recordEvent({
      actor: opts.actor,
      type: 'api-token-revoked',
      summary: `Public API token "${row.label}" revoked.`,
      details: { tokenId: id },
    });
  }

  /**
   * Validates a raw presented token (already stripped of the `Bearer `
   * prefix). Returns `null` on any failure — unknown hash, revoked,
   * expired, or the feature toggled off — without distinguishing which,
   * matching `BearerAuthGuard`'s single generic 401.
   */
  async resolve(rawToken: string): Promise<ResolvedApiToken | null> {
    if (!(await this.isEnabled())) return null;
    if (!rawToken) return null;

    const hash = hashToken(rawToken);
    const [row] = await this.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, hash))
      .limit(1);
    if (!row) return null;
    if (row.revoked) return null;
    if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) {
      return null;
    }

    // Best-effort, not on the request's critical path.
    this.db
      .update(apiTokens)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(apiTokens.id, row.id))
      .catch(() => undefined);

    return {
      id: row.id,
      label: row.label,
      serverIds: parseServerIds(row.serverIdsJson ?? null),
    };
  }

  /** Whether a resolved token's scope includes the given server id. */
  canSeeServer(token: ResolvedApiToken, serverId: string): boolean {
    return token.serverIds === null || token.serverIds.includes(serverId);
  }

  /** Servers a resolved token may see, intersected against the live server list. */
  async visibleServerIds(token: ResolvedApiToken): Promise<Set<string>> {
    const rows = await this.db
      .select({ id: servers.id })
      .from(servers)
      .where(isNull(servers.deletedAt));
    const all = rows.map((r) => r.id);
    if (token.serverIds === null) return new Set(all);
    const scoped = new Set(token.serverIds);
    return new Set(all.filter((id) => scoped.has(id)));
  }
}
