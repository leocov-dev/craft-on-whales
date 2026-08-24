import {
  Injectable,
  HttpException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import * as path from 'node:path';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { serverPacks, servers } from '../db/schema';
import { EventsService } from '../events/events.service';
import { ServerQueryService } from '../servers/server-query.service';
import type { Server } from '../servers/types';
import { JavaMatrixService } from '../servers/java-matrix.service';
import { ModrinthApiService } from '../mods/modrinth-api.service';
import { CurseforgeApiService } from '../mods/curseforge-api.service';
import { GtnhApiService } from '../mods/gtnh-api.service';
import { PackwizApiService } from '../mods/packwiz-api.service';
import { ModsService } from '../mods/mods.service';
import { PathGuardService } from '../storage/path-guard.service';
import { WorldPropsService } from '../worlds/world-props.service';
import { WorldArchiveService } from '../worlds/world-archive.service';
import type {
  PackLatestInfo,
  PackPlatform,
  ResolvePackOptions,
  ResolvedPack,
} from './packs.types';

type ServerPackRow = typeof serverPacks.$inferSelect;

/**
 * Modpack installation & pinning. NEVER installs an unpinned pack: "latest"
 * is resolved to a concrete version id at install time, so container
 * restarts can never silently upgrade a server (legacy discovery: unpinned
 * AUTO_CURSEFORGE/MODRINTH auto-upgrade on every start).
 */
@Injectable()
export class PacksService {
  constructor(
    private readonly dbService: DbService,
    private readonly events: EventsService,
    private readonly serverQuery: ServerQueryService,
    private readonly javaMatrix: JavaMatrixService,
    private readonly modrinth: ModrinthApiService,
    private readonly curseforge: CurseforgeApiService,
    private readonly gtnh: GtnhApiService,
    private readonly packwiz: PackwizApiService,
    private readonly mods: ModsService,
    private readonly pathGuard: PathGuardService,
    private readonly worldProps: WorldPropsService,
    private readonly worldArchive: WorldArchiveService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  /**
   * CF bare slugs default to the MODS class in curseforge.resolveUrl, but this
   * service only ever deals in MODPACKS — spell it out as a modpacks URL so
   * slugs like "all-the-mods-10" resolve. Numeric IDs and full URLs pass through.
   */
  private normalizeCurseforgeRef(ref: string): string {
    const s = String(ref).trim();
    if (/^https?:\/\//i.test(s) || /^\d+$/.test(s)) return s;
    return `https://www.curseforge.com/minecraft/modpacks/${s}`;
  }

  private pickMcVersion(gameVersions: string[] = []): string | null {
    return gameVersions.find((v) => /^\d+\.\d+(\.\d+)?$/.test(v)) || null;
  }

  /**
   * Resolve a pack reference to install candidates.
   * ref: slug/URL/id — versionId optional (null → resolve latest now, then pin).
   */
  async resolvePack(
    platform: PackPlatform,
    ref: string,
    {
      versionId = null,
      mcVersion,
      includeBeta = false,
    }: ResolvePackOptions = {},
  ): Promise<ResolvedPack> {
    if (platform === 'curseforge') {
      const project = await this.curseforge.resolveUrl(
        this.normalizeCurseforgeRef(ref),
      );
      const files = await this.curseforge.getFiles(project.modId, {
        mcVersion,
      });
      const file = versionId
        ? await this.curseforge.getFile(project.modId, Number(versionId))
        : files.find((f) => f.releaseType === 'release') || files[0];
      if (!file)
        throw new NotFoundException(
          `No installable file found for ${project.name}`,
        );
      return {
        platform,
        projectRef: project.slug,
        projectId: String(project.modId),
        projectName: project.name,
        iconUrl: project.iconUrl,
        versionId: String(file.fileId),
        versionName: file.name,
        mcVersion: this.pickMcVersion(file.gameVersions),
        allVersions: files.slice(0, 25).map((f) => ({
          id: String(f.fileId),
          name: f.name,
          type: f.releaseType,
          date: f.fileDate,
        })),
      };
    }
    if (platform === 'modrinth') {
      const project = await this.modrinth.resolveUrl(ref);
      const versions = await this.modrinth.getVersions(project.projectId, {
        mcVersion,
      });
      const version = versionId
        ? await this.modrinth.getVersion(versionId)
        : versions.find((v) => v.version_type === 'release') || versions[0];
      if (!version)
        throw new NotFoundException(
          `No installable version found for ${project.title}`,
        );
      return {
        platform,
        projectRef: project.slug,
        projectId: project.projectId,
        projectName: project.title,
        iconUrl: project.iconUrl,
        versionId: version.id,
        versionName: version.version_number,
        mcVersion:
          version.game_versions[version.game_versions.length - 1] || null,
        loaders: version.loaders,
        allVersions: versions.slice(0, 25).map((v) => ({
          id: v.id,
          name: v.version_number,
          type: v.version_type || 'release',
          date: v.date_published || null,
        })),
      };
    }
    if (platform === 'ftb') {
      const id = String(ref).match(/\d+/)?.[0];
      if (!id)
        throw new BadRequestException(
          'FTB packs are referenced by numeric modpack ID',
        );
      if (!versionId)
        throw new BadRequestException(
          'FTB installs need an explicit version ID (the panel never uses latest)',
        );
      return {
        platform,
        projectRef: id,
        projectId: id,
        projectName: `FTB pack ${id}`,
        versionId: String(versionId),
        versionName: String(versionId),
        mcVersion: null,
        allVersions: [],
      };
    }
    if (platform === 'packwiz') {
      // packwiz has no search API and no version registry: `ref` IS the
      // pack.toml URL, and "the version" is the sha256 of the resolved
      // index.toml — packwiz's own hash for exactly this content, and the
      // only stable thing to pin/compare against since pack.toml's `version`
      // field is free text authors aren't required to bump.
      if (!/^https?:\/\//i.test(ref))
        throw new BadRequestException(
          'packwiz packs are referenced by their pack.toml URL',
        );
      const resolved = await this.packwiz.resolvePack(ref);
      const loaders = (
        ['fabric', 'forge', 'quilt', 'neoforge'] as const
      ).filter((l) => resolved.pack.versions[l]);
      return {
        platform,
        projectRef: ref,
        projectId: ref,
        projectName: resolved.pack.name,
        versionId: resolved.indexHash,
        versionName: resolved.pack.version || resolved.indexHash.slice(0, 12),
        mcVersion: resolved.pack.versions.minecraft,
        loaders: loaders.length ? loaders : undefined,
        allVersions: [],
      };
    }
    // platform === 'gtnh'
    // GTNH is a single project with no search API: `ref` is the constant 'gtnh',
    // and a pack version is its own id. The Minecraft version is hardcoded
    // because the index does not state one — GTNH is a 1.7.10 pack by definition.
    const all = await this.gtnh.listVersions({ includeBeta: true });
    const entry = versionId
      ? await this.gtnh.getVersion(String(versionId))
      : this.gtnh.pickLatest(all, { includeBeta });
    if (!entry)
      throw new HttpException(
        'The GTNH release index returned no installable versions',
        502,
      );
    return {
      platform,
      projectRef: 'gtnh',
      projectId: 'gtnh',
      projectName: 'GT New Horizons',
      iconUrl: null,
      versionId: entry.version,
      versionName: entry.version,
      mcVersion: '1.7.10',
      maxJavaVersion: entry.maxJavaVersion,
      channel: entry.channel,
      javaTag: this.javaMatrix.pickJavaTag('1.7.10', 'GTNH', {
        maxJavaVersion: entry.maxJavaVersion,
      }),
      changelogUrl: entry.changelogUrl,
      allVersions: all.map((e) => ({
        id: e.version,
        name: e.version,
        type: e.channel === 'beta' ? 'beta' : 'release',
        date: e.releaseDate,
        maxJavaVersion: e.maxJavaVersion,
      })),
    };
  }

  /** Env vars implementing the PINNED install for each platform. */
  packEnv(resolved: ResolvedPack): Record<string, string> {
    if (resolved.platform === 'curseforge') {
      return {
        TYPE: 'AUTO_CURSEFORGE',
        CF_SLUG: resolved.projectRef,
        CF_FILE_ID: resolved.versionId,
      };
    }
    if (resolved.platform === 'modrinth') {
      const env: Record<string, string> = {
        TYPE: 'MODRINTH',
        MODRINTH_MODPACK: resolved.projectRef,
        MODRINTH_VERSION: resolved.versionId,
      };
      const loader = (resolved.loaders || []).find((l) =>
        ['fabric', 'forge', 'neoforge', 'quilt'].includes(l),
      );
      if (loader) env.MODRINTH_LOADER = loader;
      return env;
    }
    if (resolved.platform === 'gtnh') {
      // Deliberately NO SKIP_GTNH_UPDATE_CHECK here: the image's "update check"
      // is also its INSTALLER — with the check skipped, a fresh server never
      // downloads the pack at all and crash-loops on the missing files.
      // Pinning GTNH_PACK_VERSION alone is what prevents silent upgrades.
      return { TYPE: 'GTNH', GTNH_PACK_VERSION: resolved.versionId };
    }
    if (resolved.platform === 'packwiz') {
      // No pin var to speak of: PACKWIZ_URL always points at whatever the
      // pack currently is. "Pinning" for packwiz means the panel tracking
      // the index hash it resolved at install time (server_packs), not the
      // container image — a re-check compares the URL's CURRENT hash against
      // that stored one, same as every other platform's update check.
      return { TYPE: 'PACKWIZ', PACKWIZ_URL: resolved.projectRef };
    }
    return {
      TYPE: 'FTBA',
      FTB_MODPACK_ID: resolved.projectRef,
      FTB_MODPACK_VERSION_ID: resolved.versionId,
    };
  }

  /**
   * Apply a pack (install or version change) to an existing server:
   * updates env with the pinned reference, records server_packs, flags recreate.
   * The caller decides when to restart (upgrade orchestrator stops first).
   */
  async applyPack(
    serverId: string,
    resolved: ResolvedPack,
    {
      actor = 'system',
      force = false,
    }: { actor?: string; force?: boolean } = {},
  ): Promise<{ previous: ServerPackRow | null }> {
    const server = await this.serverQuery.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');

    // World-safety guard (learned the hard way): applying a pack that targets a
    // different MC version than the existing world either crashes on boot
    // (downgrade) or irreversibly upgrades the world. Require explicit consent.
    if (!force) {
      const warnings = this.worldVersionWarnings(server, resolved);
      if (warnings.length) {
        throw new HttpException(
          { message: warnings.join(' '), warnings, requiresForce: true },
          409,
        );
      }
    }

    const previousRows = await this.db
      .select()
      .from(serverPacks)
      .where(eq(serverPacks.serverId, serverId))
      .limit(1);
    const previous = previousRows[0] ?? null;

    // Strip EVERY previous pack-selection/exclusion env var (CF_/MODRINTH_/FTB_/GTNH_)
    // before merging the new pack env: switching platform (or even version)
    // must not leave stale slugs, file pins or exclusion lists behind. Unrelated
    // user env is preserved. SKIP_GTNH_ is its own prefix (not GTNH_-prefixed)
    // because that env var name is dictated by the container image's contract.
    const cleanedEnv: Record<string, string> = Object.fromEntries(
      Object.entries(server.env).filter(
        ([key]) => !/^(CF_|MODRINTH_|FTB_|GTNH_|SKIP_GTNH_|PACKWIZ_)/.test(key),
      ),
    );
    const env: Record<string, string> = {
      ...cleanedEnv,
      ...this.packEnv(resolved),
    };
    // GTNH's own server start scripts ship -Dfml.queryResult=confirm, and the
    // itzg launcher path loses it. Without it, the FIRST boot after any pack
    // version change over an existing world blocks forever on Forge's
    // "/fml confirm" world-migration console prompt. The panel always takes a
    // pre-update backup, so confirming is the intended path. Merge, don't
    // clobber: a user-set JVM_DD_OPTS keeps its own pairs.
    const FML_CONFIRM = 'fml.queryResult=confirm';
    if (resolved.platform === 'gtnh') {
      const user = cleanedEnv.JVM_DD_OPTS;
      env.JVM_DD_OPTS = user
        ? user.includes(FML_CONFIRM)
          ? user
          : `${user} ${FML_CONFIRM}`
        : FML_CONFIRM;
    } else if (previous && previous.platform === 'gtnh' && env.JVM_DD_OPTS) {
      // Leaving GTNH: take back only the panel's own token; user pairs survive.
      const stripped = env.JVM_DD_OPTS.split(/[\s,]+/).filter(
        (pair) => pair && pair !== FML_CONFIRM,
      );
      if (stripped.length) env.JVM_DD_OPTS = stripped.join(' ');
      else delete env.JVM_DD_OPTS;
    }
    // The TYPE lives in its own column; keep env's TYPE out of the extras.
    const type = env.TYPE!;
    delete env.TYPE;

    await this.db
      .update(servers)
      .set({
        type,
        envJson: JSON.stringify(env),
        pendingRecreate: true,
        ...(resolved.mcVersion ? { mcVersion: resolved.mcVersion } : {}),
      })
      .where(eq(servers.id, serverId));

    await this.db
      .insert(serverPacks)
      .values({
        serverId,
        platform: resolved.platform,
        projectRef: resolved.projectRef,
        projectName: resolved.projectName,
        pinnedVersionId: resolved.versionId,
        pinnedVersionName: resolved.versionName,
        previousVersionId: previous ? previous.pinnedVersionId : null,
        previousVersionName: previous ? previous.pinnedVersionName : null,
        maxJavaVersion: resolved.maxJavaVersion ?? null,
        channel: resolved.channel ?? null,
      })
      .onConflictDoUpdate({
        target: serverPacks.serverId,
        set: {
          platform: resolved.platform,
          projectRef: resolved.projectRef,
          projectName: resolved.projectName,
          pinnedVersionId: resolved.versionId,
          pinnedVersionName: resolved.versionName,
          previousVersionId: previous ? previous.pinnedVersionId : null,
          previousVersionName: previous ? previous.pinnedVersionName : null,
          maxJavaVersion: resolved.maxJavaVersion ?? null,
          channel: resolved.channel ?? null,
        },
      });

    this.events.recordEvent({
      serverId,
      actor,
      type: previous ? 'modpack-updated' : 'modpack-applied',
      summary: previous
        ? `Pack ${resolved.projectName}: ${previous.pinnedVersionName} → ${resolved.versionName} (pinned)`
        : `Pack applied: ${resolved.projectName} @ ${resolved.versionName} (pinned)`,
      details: {
        platform: resolved.platform,
        versionId: resolved.versionId,
        previous: previous ? previous.pinnedVersionId : null,
      },
    });
    return { previous };
  }

  async getPack(serverId: string): Promise<ServerPackRow | null> {
    const [row] = await this.db
      .select()
      .from(serverPacks)
      .where(eq(serverPacks.serverId, serverId))
      .limit(1);
    return row ?? null;
  }

  /** Latest available version for a server's pinned pack (for the update checker). */
  async latestFor(serverId: string): Promise<PackLatestInfo | null> {
    const pack = await this.getPack(serverId);
    if (!pack) return null;
    if (pack.platform === 'ftb') return null; // FTB API not wired for checks yet
    if (pack.platform === 'packwiz') {
      // No version registry to page through: re-fetch the pinned URL and
      // compare index hashes. `projectRef` IS the pack.toml URL for packwiz.
      const resolved = await this.packwiz.resolvePack(pack.projectRef);
      return {
        current: { id: pack.pinnedVersionId, name: pack.pinnedVersionName },
        latest: {
          id: resolved.indexHash,
          name: resolved.pack.version || resolved.indexHash.slice(0, 12),
        },
        updateAvailable: resolved.indexHash !== pack.pinnedVersionId,
        projectName: pack.projectName,
        projectRef: pack.projectRef,
        platform: pack.platform,
      };
    }
    if (pack.platform === 'gtnh') {
      // Track the channel this server was pinned from: a stable server must never
      // be offered a beta, and a beta server should see beta releases.
      const newest = await this.gtnh.latest({
        includeBeta: pack.channel === 'beta',
      });
      if (!newest) return null;
      return {
        current: { id: pack.pinnedVersionId, name: pack.pinnedVersionName },
        latest: { id: newest.version, name: newest.version },
        updateAvailable: newest.version !== pack.pinnedVersionId,
        projectName: pack.projectName,
        projectRef: pack.projectRef,
        platform: pack.platform,
        changelogUrl: newest.changelogUrl,
      };
    }
    // Scope "latest" to the server's own MC version — otherwise the checker
    // offers upgrades that silently cross MC versions.
    const server = await this.serverQuery.getServer(serverId);
    const mcVersion =
      server && !['LATEST', 'SNAPSHOT'].includes(server.mc_version)
        ? server.mc_version
        : undefined;
    const resolved = await this.resolvePack(
      pack.platform as PackPlatform,
      pack.projectRef,
      { mcVersion },
    );
    return {
      current: { id: pack.pinnedVersionId, name: pack.pinnedVersionName },
      latest: { id: resolved.versionId, name: resolved.versionName },
      updateAvailable: resolved.versionId !== pack.pinnedVersionId,
      projectName: pack.projectName,
      projectRef: pack.projectRef,
      platform: pack.platform,
    };
  }

  /** After any pack install/update completes on disk, restore the overlay. */
  async afterPackOperation(
    serverId: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<{ restored: number }> {
    return this.mods.reapplyOverlay(serverId, { actor });
  }

  /** Warnings when a pack's MC version conflicts with the server's existing world. */
  private worldVersionWarnings(
    server: Server,
    resolved: ResolvedPack,
  ): string[] {
    if (!resolved.mcVersion) return [];
    const warnings: string[] = [];
    try {
      const level = this.worldProps.activeLevelName(server);
      const worldVersion = this.worldArchive.readLevelVersion(
        path.join(
          this.pathGuard.dataPath('servers', server.id),
          level,
          'level.dat',
        ),
      );
      if (worldVersion && worldVersion !== resolved.mcVersion) {
        const wv = this.javaMatrix.parseVersion(worldVersion);
        const pv = this.javaMatrix.parseVersion(resolved.mcVersion);
        const downgrade =
          wv &&
          pv &&
          (pv.major < wv.major ||
            (pv.major === wv.major &&
              (pv.minor < wv.minor ||
                (pv.minor === wv.minor && pv.patch < wv.patch))));
        warnings.push(
          downgrade
            ? `This pack runs Minecraft ${resolved.mcVersion} but the existing world was generated on ${worldVersion} — Minecraft cannot load newer worlds on older versions and the server will crash. Reset or swap the world first, or confirm to proceed anyway.`
            : `This pack runs Minecraft ${resolved.mcVersion} but the existing world is from ${worldVersion} — starting will permanently upgrade the world (make a backup first).`,
        );
      }
    } catch {
      /* unreadable level.dat → no warning */
    }
    return warnings;
  }
}
