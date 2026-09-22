import { ConflictException, Injectable } from '@nestjs/common';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { EventsService } from '../events/events.service';
import { ServerQueryService } from '../servers/server-query.service';
import { PacksService } from '../packs/packs.service';
import { ModrinthApiService } from '../mods/modrinth-api.service';
import { CurseforgeApiService } from '../mods/curseforge-api.service';
import { ModsService } from '../mods/mods.service';
import { ApiCacheService } from '../mods/api-cache.service';
import {
  serverContent,
  libraryFiles,
  servers,
  serverPacks,
  updateChecks,
} from '../db/schema';
import type { UpdateFinding, OutdatedRow } from './updates.types';

interface UpsertCheckOptions {
  isNew: boolean;
  latestId: string | null;
  latestName: string | null;
  changelogUrl: string | null;
}

/**
 * Update checker: compares pinned packs, overlay mods, and (eventually) the
 * base image against the latest available, caching results in
 * `update_checks`. Scheduled daily + on-demand; ports `src/updates/checker.ts`.
 */
@Injectable()
export class UpdateCheckerService {
  constructor(
    private readonly dbService: DbService,
    private readonly events: EventsService,
    private readonly serverQuery: ServerQueryService,
    private readonly packs: PacksService,
    private readonly modrinth: ModrinthApiService,
    private readonly curseforge: CurseforgeApiService,
    private readonly mods: ModsService,
    private readonly apiCache: ApiCacheService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  async checkAll({ actor = 'scheduler' }: { actor?: string } = {}): Promise<
    UpdateFinding[]
  > {
    const findings: UpdateFinding[] = [];
    for (const server of await this.serverQuery.listServers()) {
      // Pack updates
      try {
        const result = await this.packs.latestFor(server.id);
        if (result) {
          // GTNH's latestFor already surfaces a real per-version diff link off
          // the index entry itself — prefer that over the platform-derived
          // fallback (which, for GTNH, is only the generic changelogs
          // directory).
          const changelog = result.updateAvailable
            ? result.changelogUrl ||
              this.packChangelogUrl(result.platform, result.projectRef || '')
            : null;
          await this.upsertCheck('pack', server.id, result.current.name || '', {
            isNew: result.updateAvailable,
            latestId: result.latest.id,
            latestName: result.latest.name,
            changelogUrl: changelog,
          });
          if (result.updateAvailable) {
            findings.push({
              server: server.display_name,
              kind: 'pack',
              subject: result.projectName || '',
              current: result.current.name,
              latest: result.latest.name,
            });
          }
        }
      } catch {
        /* pack platform unreachable — keep old cache */
      }

      // Overlay mod updates
      const rows = await this.db
        .select({
          id: serverContent.id,
          name: serverContent.name,
          libVersion: libraryFiles.version,
          platform: libraryFiles.platform,
          projectId: libraryFiles.projectId,
        })
        .from(serverContent)
        .innerJoin(libraryFiles, eq(libraryFiles.id, serverContent.libraryId))
        .where(
          and(
            eq(serverContent.serverId, server.id),
            eq(serverContent.managedBy, 'overlay'),
            isNotNull(libraryFiles.projectId),
          ),
        );
      const mcVersion =
        server.mc_version === 'LATEST' || server.mc_version === 'SNAPSHOT'
          ? undefined
          : server.mc_version;
      const loader = this.mods.loaderOf(server) ?? undefined;
      for (const row of rows) {
        try {
          let latest: { id: string; name: string } | null = null;
          let changelogUrl: string | null = null;
          if (row.platform === 'modrinth' && row.projectId) {
            const versions = await this.modrinth.getVersions(row.projectId, {
              loader,
              mcVersion,
            });
            const first = versions[0];
            if (first) latest = { id: first.id, name: first.version_number };
            changelogUrl = `https://modrinth.com/project/${row.projectId}/changelog`;
          } else if (row.platform === 'curseforge' && row.projectId) {
            const files = await this.curseforge.getFiles(
              Number(row.projectId),
              { mcVersion, loader },
            );
            const first = files[0];
            if (first) latest = { id: String(first.fileId), name: first.name };
            changelogUrl = `https://www.curseforge.com/projects/${row.projectId}`;
          }
          if (latest) {
            // Name-to-name comparison — mods.updateFor and listOutdated use the
            // same rule, so a check can never invent a phantom update.
            const isNew = latest.name !== row.libVersion;
            await this.upsertCheck('content', row.id, row.libVersion || '?', {
              isNew,
              latestId: latest.id,
              latestName: latest.name,
              changelogUrl: isNew ? changelogUrl : null,
            });
            if (isNew) {
              findings.push({
                server: server.display_name,
                kind: 'mod',
                subject: row.name,
                current: row.libVersion,
                latest: latest.name,
              });
            }
          }
        } catch {
          /* skip this mod */
        }
      }
    }

    await this.apiCache.set('last-update-check', { findings: findings.length });
    this.events.recordEvent({
      actor,
      type: 'update-check',
      summary: findings.length
        ? `Update check: ${findings.length} update(s) available`
        : 'Update check: everything up to date',
      details: { findings: findings as unknown as Record<string, unknown> },
    });
    return findings;
  }

  /**
   * Cache one check result. The latest_* columns are only populated when the
   * subject is ACTUALLY outdated (isNew) — latestVersion holds the platform
   * id, latestName the human-readable version name. Up-to-date subjects get
   * NULLs, so `latestVersion IS NOT NULL` cleanly means "update available".
   */
  /** Also called by PackwizWatcherService, which runs pack-hash checks for
   *  packwiz servers on its own cadence outside checkAll() — see PACKS_NOTES.md. */
  async upsertCheck(
    subjectType: 'pack' | 'content',
    subjectId: string,
    current: string,
    { isNew, latestId, latestName, changelogUrl }: UpsertCheckOptions,
  ): Promise<void> {
    await this.db
      .insert(updateChecks)
      .values({
        subjectType,
        subjectId,
        currentVersion: current,
        latestVersion: isNew ? latestId : null,
        latestName: isNew ? latestName : null,
        changelogUrl: isNew ? changelogUrl : null,
      })
      .onConflictDoUpdate({
        target: [updateChecks.subjectType, updateChecks.subjectId],
        set: {
          currentVersion: current,
          latestVersion: isNew ? latestId : null,
          latestName: isNew ? latestName : null,
          changelogUrl: isNew ? changelogUrl : null,
          checkedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
        },
      });
  }

  private packChangelogUrl(
    platform: string,
    projectRef: string,
  ): string | null {
    if (platform === 'modrinth')
      return `https://modrinth.com/project/${projectRef}/changelog`;
    if (platform === 'curseforge')
      return `https://www.curseforge.com/minecraft/modpacks/${projectRef}/files`;
    // Fallback only: latestFor's gtnh branch normally supplies a real
    // per-version link straight from the index entry (see checkAll above).
    // This is the "all files" equivalent for the rare case a version's
    // changelog href didn't pass safeChangelogUrl's github.com/https check.
    if (platform === 'gtnh')
      return 'https://github.com/GTNewHorizons/DreamAssemblerXXL/tree/master/releases/changelogs';
    return null;
  }

  /**
   * Everything outdated, joined for the Updates page. Excludes a build the
   * user has ignored (`ignoredVersion === latestVersion`) — see
   * UPDATES_NOTES.md. Pass `includeIgnored: true` to get the full set
   * instead (used by `listIgnored`).
   */
  async listOutdated({
    includeIgnored = false,
  }: { includeIgnored?: boolean } = {}): Promise<OutdatedRow[]> {
    const rows: OutdatedRow[] = [];
    const checks = await this.db
      .select()
      .from(updateChecks)
      .where(isNotNull(updateChecks.latestVersion));
    for (const c of checks) {
      const isIgnored =
        Boolean(c.ignoredVersion) && c.ignoredVersion === c.latestVersion;
      if (isIgnored !== includeIgnored) continue;
      if (c.subjectType === 'pack') {
        const [server] = await this.db
          .select({ id: servers.id, displayName: servers.displayName })
          .from(servers)
          .where(and(eq(servers.id, c.subjectId), isNull(servers.deletedAt)))
          .limit(1);
        const [pack] = await this.db
          .select()
          .from(serverPacks)
          .where(eq(serverPacks.serverId, c.subjectId))
          .limit(1);
        if (server && pack && pack.pinnedVersionId !== c.latestVersion) {
          rows.push({
            serverId: server.id,
            server: server.displayName,
            kind: 'Modpack',
            subject: pack.projectName,
            current: pack.pinnedVersionName,
            latest: c.latestName,
            versionId: c.latestVersion,
            changelogUrl: c.changelogUrl || null,
            subjectType: 'pack',
            subjectId: c.subjectId,
          });
        }
      } else if (c.subjectType === 'content') {
        const [row] = await this.db
          .select({
            id: serverContent.id,
            name: serverContent.name,
            version: serverContent.version,
            serverId: servers.id,
            displayName: servers.displayName,
          })
          .from(serverContent)
          .innerJoin(
            servers,
            and(
              eq(servers.id, serverContent.serverId),
              isNull(servers.deletedAt),
            ),
          )
          .where(eq(serverContent.id, c.subjectId))
          .limit(1);
        // Name-to-name: skip rows the user already updated since the last check.
        if (row && c.latestName && c.latestName !== row.version) {
          rows.push({
            serverId: row.serverId,
            server: row.displayName,
            kind: 'Mod (overlay)',
            subject: row.name,
            current: c.currentVersion,
            latest: c.latestName,
            contentId: row.id,
            changelogUrl: c.changelogUrl || null,
            subjectType: 'content',
            subjectId: row.id,
          });
        }
      }
    }
    return rows;
  }

  /** Updates the user has ignored, for the "Ignored updates" panel. */
  async listIgnored(): Promise<OutdatedRow[]> {
    return this.listOutdated({ includeIgnored: true });
  }

  /**
   * Ignore the currently-known latest build/version for one subject —
   * removes it from `listOutdated` (and everything that reads through it)
   * until a build newer than the one just ignored appears.
   */
  async ignoreUpdate(
    subjectType: 'pack' | 'content',
    subjectId: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<{ ignoredVersion: string }> {
    const [check] = await this.db
      .select()
      .from(updateChecks)
      .where(
        and(
          eq(updateChecks.subjectType, subjectType),
          eq(updateChecks.subjectId, subjectId),
        ),
      )
      .limit(1);
    if (!check || !check.latestVersion)
      throw new ConflictException(
        'No update is currently known for this — run an update check first',
      );
    await this.db
      .update(updateChecks)
      .set({ ignoredVersion: check.latestVersion })
      .where(
        and(
          eq(updateChecks.subjectType, subjectType),
          eq(updateChecks.subjectId, subjectId),
        ),
      );
    this.events.recordEvent({
      actor,
      type: 'update-ignored',
      summary: `Ignored update: ${check.latestName || check.latestVersion}`,
      details: { subjectType, subjectId, ignoredVersion: check.latestVersion },
    });
    return { ignoredVersion: check.latestVersion };
  }

  /** Clear a previously-ignored build so it counts as "available" again. */
  async clearIgnoredUpdate(
    subjectType: 'pack' | 'content',
    subjectId: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<void> {
    await this.db
      .update(updateChecks)
      .set({ ignoredVersion: null })
      .where(
        and(
          eq(updateChecks.subjectType, subjectType),
          eq(updateChecks.subjectId, subjectId),
        ),
      );
    this.events.recordEvent({
      actor,
      type: 'update-ignored',
      summary: 'Cleared an ignored update',
      details: { subjectType, subjectId },
    });
  }

  async lastCheckedAt(): Promise<string | null> {
    const row = await this.apiCache.get('last-update-check');
    return row
      ? new Date(Date.now() - row.ageMs)
          .toISOString()
          .slice(0, 19)
          .replace('T', ' ')
      : null;
  }
}
