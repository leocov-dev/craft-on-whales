import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { eq, and } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { integrations } from '../db/schema';
import { ServerQueryService } from '../servers/server-query.service';
import type { StatusPageConfig } from '../../../shared/types/integrations';

export type { StatusPageConfig };

const KIND = 'status-page';
const SLUG_RE = /^[a-z0-9-]{3,40}$/;

export interface PublicStatusPage {
  name: string;
  icon: string;
  accent: string;
  motd: string;
  flavor: string;
  mcVersion: string;
  status: string;
}

/**
 * Public status page config (MP9). Opt-in per server; the slug is the only
 * thing exposed publicly, stored in the `integrations` table's plain
 * `config_json` under kind `status-page` (nothing secret here).
 *
 * `loadPublicPage` only returns what's derivable from the `servers` row
 * (no live Docker query) — legacy's `serverVM` composes this with live
 * player-count/uptime/online stats from the in-memory Docker cache, which
 * belongs to a future view-model layer built alongside the public status
 * controller; deliberately not ported here per the "service layer only"
 * scope for this module.
 */
@Injectable()
export class StatusService {
  constructor(
    private readonly dbService: DbService,
    private readonly serverQuery: ServerQueryService
  ) {}

  private get db() {
    return this.dbService.db;
  }

  async getStatusPage(serverId: string): Promise<StatusPageConfig> {
    const [row] = await this.db
      .select()
      .from(integrations)
      .where(and(eq(integrations.serverId, serverId), eq(integrations.kind, KIND)))
      .limit(1);
    const cfg = row ? JSON.parse(row.configJson || '{}') : {};
    return {
      enabled: Boolean(row?.enabled),
      slug: cfg.slug || null,
      path: cfg.slug ? `/status/${cfg.slug}` : null,
    };
  }

  async setStatusPage(serverId: string, { enabled, slug }: { enabled?: boolean; slug?: string }): Promise<StatusPageConfig> {
    // Disabling never needs a slug — keep the stored one so re-enabling
    // restores the same address.
    if (!enabled && !slug) {
      const existing = await this.getStatusPage(serverId);
      await this.upsert(serverId, false, { slug: existing.slug || null });
      return this.getStatusPage(serverId);
    }
    if (!slug || !SLUG_RE.test(slug)) {
      throw new BadRequestException('Slug must be 3–40 chars of lowercase letters, digits, or dashes');
    }
    const rows = await this.db
      .select({ serverId: integrations.serverId, configJson: integrations.configJson })
      .from(integrations)
      .where(eq(integrations.kind, KIND));
    const clash = rows.find((r) => r.serverId !== serverId && JSON.parse(r.configJson || '{}').slug === slug);
    if (clash) throw new ConflictException(`The slug "${slug}" is already used by another server`);

    await this.upsert(serverId, Boolean(enabled), { slug });
    return this.getStatusPage(serverId);
  }

  private async upsert(serverId: string, enabled: boolean, config: Record<string, unknown>): Promise<void> {
    await this.db
      .insert(integrations)
      .values({ serverId, kind: KIND, enabled, configJson: JSON.stringify(config) })
      .onConflictDoUpdate({
        target: [integrations.serverId, integrations.kind],
        set: { enabled, configJson: JSON.stringify(config), updatedAt: new Date().toISOString().slice(0, 19).replace('T', ' ') },
      });
  }

  /** Resolve an ENABLED status page by slug → server_id, or null. */
  async findBySlug(slug: string): Promise<string | null> {
    if (!SLUG_RE.test(slug)) return null;
    const rows = await this.db
      .select({ serverId: integrations.serverId, configJson: integrations.configJson })
      .from(integrations)
      .where(and(eq(integrations.kind, KIND), eq(integrations.enabled, true)));
    const row = rows.find((r) => JSON.parse(r.configJson || '{}').slug === slug);
    return row ? row.serverId : null;
  }

  async loadPublicPage(slug: string): Promise<PublicStatusPage | null> {
    const serverId = await this.findBySlug(slug);
    const row = serverId ? await this.serverQuery.getServer(serverId) : null;
    if (!row) return null;
    return {
      name: row.display_name,
      icon: row.icon,
      accent: row.accent,
      motd: (row.env?.MOTD || '').replace(/[§&][0-9a-fk-or]/gi, ''),
      flavor: row.type,
      mcVersion: row.mc_version,
      status: row.status,
    };
  }
}
