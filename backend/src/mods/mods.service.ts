import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import { eq, and } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { PathGuardService } from '../storage/path-guard.service';
import { StorageIndexService } from '../storage/storage-index.service';
import { EventsService } from '../events/events.service';
import {
  LibraryService,
  truncateHash,
  type DownloadMeta,
  type LibraryFileRow,
} from '../library/library.service';
import { ModrinthApiService } from './modrinth-api.service';
import {
  CurseforgeApiService,
  curseforgeExpectedHash,
  curseforgePageUrl,
} from './curseforge-api.service';
import { BlockedDownloadException } from './blocked-download.exception';
import { HangarApiService, hangarExpectedHash } from './hangar-api.service';
import { SpigetApiService } from './spiget-api.service';
import {
  GithubReleasesApiService,
  githubAssetExpectedHash,
  parseGithubRef,
  pickGithubAsset,
  pickGithubRelease,
} from './github-releases-api.service';
import { ServerQueryService } from '../servers/server-query.service';
import { ServerLifecycleService } from '../servers/server-lifecycle.service';
import { ModManifestService } from './mod-manifest.service';
import { PendingModDownloadsService } from './pending-mod-downloads.service';
import { serverContent, updateChecks } from '../db/schema';
import type { Server } from '../servers/types';
import type {
  ContentItem,
  PendingDownload,
  ContentKind as SharedContentKind,
} from '../../../shared/types/mods';
import type {
  BrowsablePlatform,
  HangarVersion,
  ModPlatform,
} from './mods.types';

export type { ContentItem, PendingDownload };

// Per-server content management (mods/plugins/datapacks/resourcepacks).
// Two classes of content, handled differently on purpose (see discovery):
//   pack    — installed by the itzg pack installer; deleting the jar triggers
//             re-install, so disable goes through CF_EXCLUDE_MODS /
//             MODRINTH_EXCLUDE_FILES (+ *_FORCE_SYNCHRONIZE) and a recreate.
//   overlay — panel-managed via the shared library; survives pack updates;
//             toggled instantly by renaming to .jar.disabled.

const PLUGIN_TYPES = new Set([
  'PAPER',
  'PURPUR',
  'PUFFERFISH',
  'LEAF',
  'FOLIA',
  'SPIGOT',
  'BUKKIT',
  'CANYON',
]);

type ContentKind = SharedContentKind;

type ModSourceKind = ModPlatform | 'direct' | 'invalid';

interface ClassifiedModSource {
  kind: ModSourceKind;
  ref: string;
}

/** What the server being installed into constrains a registry lookup to. */
interface InstallTarget {
  mcVersion?: string;
  loader?: string;
}

/** A source resolved to one concrete file, ready for LibraryService.downloadToLibrary. */
interface ResolvedDownload {
  downloadUrl: string;
  meta: DownloadMeta;
}

@Injectable()
export class ModsService {
  private readonly logger = new Logger(ModsService.name);

  constructor(
    private readonly dbService: DbService,
    private readonly pathGuard: PathGuardService,
    private readonly indexer: StorageIndexService,
    private readonly events: EventsService,
    private readonly library: LibraryService,
    private readonly modrinth: ModrinthApiService,
    private readonly curseforge: CurseforgeApiService,
    private readonly hangar: HangarApiService,
    private readonly spiget: SpigetApiService,
    private readonly github: GithubReleasesApiService,
    private readonly query: ServerQueryService,
    private readonly lifecycle: ServerLifecycleService,
    private readonly manifest: ModManifestService,
    private readonly pendingDownloadsSvc: PendingModDownloadsService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  // Content filenames must be bare names inside the server's content dir. dataPath()
  // only guarantees containment within DATA_DIR, so a `file` like "../../../panel.db"
  // would still resolve (escaping the server dir to a panel-internal file). Reject any
  // separator, NUL, or dot-segment before it reaches a path join.
  private assertBareContentName(file: string | null | undefined): string {
    const name = String(file || '');
    if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) {
      throw new BadRequestException('Invalid content filename');
    }
    return name;
  }

  /** Overlay content dir for a given server type + content kind (e.g. `mods`, `plugins`). Public: also used by BlueprintsModule's overlay installer. */
  contentDir(server: Pick<Server, 'type'>, kind: ContentKind): string {
    if (kind === 'datapack') return 'world/datapacks';
    if (kind === 'resourcepack') return 'resourcepacks';
    return PLUGIN_TYPES.has(server.type) ? 'plugins' : 'mods';
  }

  /** Whether jars on this server are plugins (Paper family) or mods. */
  jarKindFor(server: Pick<Server, 'type'>): 'mod' | 'plugin' {
    return PLUGIN_TYPES.has(server.type) ? 'plugin' : 'mod';
  }

  /** packwiz owns its server's mods outright; nothing can be added beside it. */
  assertAcceptsManualContent(server: Pick<Server, 'type'>): void {
    if (server.type === 'PACKWIZ') {
      throw new BadRequestException(
        'mods managed by packwiz can’t be added manually — edit the pack and re-apply the URL instead',
      );
    }
  }

  /**
   * Link a library file into the server's content dir and record it as an
   * overlay row: the shared tail of every panel install path. Checks the
   * disk quota first. `importId` ties the row to a zip / .mrpack import.
   */
  async addLibraryContent(
    server: Server,
    lib: Pick<
      LibraryFileRow,
      'id' | 'name' | 'version' | 'iconUrl' | 'sizeBytes'
    >,
    kind: ContentKind,
    { importId = null }: { importId?: string | null } = {},
  ): Promise<{ id: string; filename: string }> {
    await this.indexer.assertUnderQuota(server, lib.sizeBytes);
    const { filename } = await this.library.installToServer(
      lib.id,
      server.id,
      this.contentDir(server, kind),
    );
    const id = `sc_${nanoid(8)}`;
    await this.db
      .insert(serverContent)
      .values({
        id,
        serverId: server.id,
        libraryId: lib.id,
        kind,
        managedBy: 'overlay',
        name: lib.name,
        filename,
        version: lib.version,
        iconUrl: lib.iconUrl,
        importId,
      })
      .onConflictDoUpdate({
        target: [serverContent.serverId, serverContent.filename],
        set: { libraryId: lib.id, version: lib.version, importId },
      });
    return { id, filename };
  }

  // Modpack servers don't set CF_MOD_LOADER/MODRINTH_LOADER — the pack itself
  // decides the loader. mc-image-helper writes a per-loader manifest into the data
  // dir (e.g. .neoforge-manifest.json), so detect from that; otherwise mod installs
  // have no loader to match and grab an arbitrary (e.g. Fabric) build.
  private detectPackLoader(serverId: string): string | null {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.pathGuard.dataPath('servers', serverId));
    } catch {
      return null;
    }
    for (const loader of ['neoforge', 'forge', 'fabric', 'quilt']) {
      if (names.includes(`.${loader}-manifest.json`)) return loader;
    }
    return null;
  }

  loaderOf(server: Server): string | null {
    const map: Record<string, string> = {
      FABRIC: 'fabric',
      QUILT: 'quilt',
      FORGE: 'forge',
      NEOFORGE: 'neoforge',
    };
    if (map[server.type]) return map[server.type]!;
    if (PLUGIN_TYPES.has(server.type)) return 'paper';
    if (
      server.type === 'AUTO_CURSEFORGE' ||
      server.type === 'MODRINTH' ||
      server.type === 'FTBA'
    ) {
      const envLoader = (
        server.env.MODRINTH_LOADER ||
        server.env.CF_MOD_LOADER ||
        ''
      ).toLowerCase();
      return envLoader || this.detectPackLoader(server.id) || null;
    }
    // packwiz has no env var carrying the loader (PACKWIZ_URL is the only
    // install-time env it sets) — the on-disk manifest sniff is the only source.
    if (server.type === 'PACKWIZ')
      return this.detectPackLoader(server.id) || null;
    return null;
  }

  isPackServer(server: Pick<Server, 'type'>): boolean {
    return [
      'AUTO_CURSEFORGE',
      'MODRINTH',
      'FTBA',
      'CURSEFORGE',
      'GTNH',
      'PACKWIZ',
    ].includes(server.type);
  }

  private async updateFor(
    row: typeof serverContent.$inferSelect | undefined,
  ): Promise<string | null> {
    if (!row) return null;
    const [check] = await this.db
      .select({
        latestVersion: updateChecks.latestVersion,
        latestName: updateChecks.latestName,
        ignoredVersion: updateChecks.ignoredVersion,
      })
      .from(updateChecks)
      .where(
        and(
          eq(updateChecks.subjectType, 'content'),
          eq(updateChecks.subjectId, row.id),
        ),
      )
      .limit(1);
    // latestName is only set when the checker saw a genuinely newer build;
    // compare name-to-name (latestVersion holds the platform id, not a name).
    // An ignored build (ignoredVersion === latestVersion) doesn't count as
    // available until a newer one supersedes it — see UPDATES_NOTES.md.
    if (check?.ignoredVersion && check.ignoredVersion === check.latestVersion)
      return null;
    return check && check.latestName && check.latestName !== row.version
      ? check.latestName
      : null;
  }

  /** List installed content: DB overlay rows + on-disk scan for pack/unknown files. */
  async listContent(serverId: string): Promise<ContentItem[]> {
    const server = await this.query.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');
    const kind: ContentKind = PLUGIN_TYPES.has(server.type) ? 'plugin' : 'mod';
    const dirRel = this.contentDir(server, kind);
    const dirAbs = this.pathGuard.dataPath('servers', serverId, dirRel);

    const rows = await this.db
      .select()
      .from(serverContent)
      .where(eq(serverContent.serverId, serverId));
    const byFile = new Map(
      rows.map((r) => [r.filename.replace(/\.disabled$/, ''), r]),
    );
    const seen = new Set<string>();
    const items: ContentItem[] = [];

    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await fsp.readdir(dirAbs, { withFileTypes: true });
    } catch {
      /* dir doesn't exist yet */
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const isDisabled = entry.name.endsWith('.disabled');
      const baseName = entry.name.replace(/\.disabled$/, '');
      if (!baseName.endsWith('.jar') && !baseName.endsWith('.zip')) continue;
      seen.add(baseName);
      const row = byFile.get(baseName);
      const stat = await fsp
        .stat(path.join(dirAbs, entry.name))
        .catch(() => null);
      const lib =
        row && row.libraryId
          ? await this.library.getLibraryFile(row.libraryId)
          : undefined;
      items.push({
        id: row ? row.id : null,
        name: row ? row.name : this.prettifyJarName(baseName),
        file: baseName,
        kind,
        source: row
          ? row.managedBy
          : this.isPackServer(server)
            ? 'pack'
            : 'unknown',
        version: row ? row.version : null,
        size: stat ? stat.size : 0,
        enabled: !isDisabled,
        disabledVia:
          row && row.managedBy === 'pack' && !isDisabled ? null : undefined,
        sharedWith: lib ? await this.library.usageCount(lib.id) : null,
        iconUrl:
          (lib && lib.iconRelPath
            ? `/${lib.iconRelPath}`
            : (lib && lib.iconUrl) || (row && row.iconUrl)) || null,
        updateAvailable: await this.updateFor(row),
        importId: row ? row.importId : null,
      });
    }
    // Overlay rows whose files vanished (user deleted manually) — surface them.
    for (const row of rows) {
      const base = row.filename.replace(/\.disabled$/, '');
      if (!seen.has(base)) {
        items.push({
          id: row.id,
          name: row.name,
          file: base,
          kind: row.kind as ContentKind,
          source: row.managedBy,
          version: row.version,
          size: 0,
          enabled: false,
          missing: true,
          sharedWith: null,
          iconUrl: row.iconUrl,
          importId: row.importId,
        });
      }
    }
    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Classify an install reference. Pure routing decision, no network.
   *  - modrinth:   modrinth.com page URLs and bare project slugs
   *  - curseforge: curseforge.com page URLs
   *  - hangar:     hangar.papermc.io project/version page URLs
   *  - spiget:     spigotmc.org resource page URLs
   *  - github:     github.com repo/release URLs, `.jar` release-asset links,
   *                and bare `owner/repo`
   *  - direct:     any other URL, INCLUDING cdn.modrinth.com file links —
   *                those are downloads, not project pages — and non-jar
   *                GitHub release assets (e.g. a datapack .zip)
   * A URL pasted without its `https://` is accepted when it starts with a
   * dotted host followed by a path.
   */
  classifyModSource(input: string | null | undefined): ClassifiedModSource {
    const trimmed = String(input || '').trim();
    const ref =
      !/^https?:\/\//i.test(trimmed) && /^[\w-]+(\.[\w-]+)+\//.test(trimmed)
        ? `https://${trimmed}`
        : trimmed;
    if (/^https?:\/\//i.test(ref)) {
      let url: URL;
      try {
        url = new URL(ref);
      } catch {
        return { kind: 'invalid', ref };
      }
      const host = url.hostname.toLowerCase().replace(/^www\./, '');
      if (host === 'modrinth.com') return { kind: 'modrinth', ref };
      if (host === 'curseforge.com') return { kind: 'curseforge', ref };
      if (host === 'hangar.papermc.io') return { kind: 'hangar', ref };
      if (host === 'spigotmc.org') return { kind: 'spiget', ref };
      if (host === 'github.com') {
        const gh = parseGithubRef(ref);
        // The GitHub client only deals in .jar assets; any other release
        // asset (a datapack/resource-pack .zip) stays a plain download.
        if (gh && (!gh.asset || /\.jar$/i.test(gh.asset)))
          return { kind: 'github', ref };
      }
      return { kind: 'direct', ref };
    }
    // Modrinth slugs never contain "/", so `owner/repo` is unambiguously GitHub.
    if (ref.includes('/'))
      return parseGithubRef(ref)
        ? { kind: 'github', ref }
        : { kind: 'invalid', ref };
    // Modrinth slug charset (their documented rule): [\w!@$()`.+,"\-'] ×3–64.
    // \w keeps underscores valid — sodium_extra style slugs used to 500.
    if (/^[\w!@$()`.+,"\-']{3,64}$/.test(ref)) return { kind: 'modrinth', ref };
    return { kind: 'invalid', ref };
  }

  /**
   * Inverse of classifyModSource for the browsable platforms: build a project
   * (or project+version) page URL, the shape installFromUrl accepts. Shared so
   * mods.controller.ts's update() and mod-browser-orchestrator.service.ts's
   * fromMods() don't each hand-roll the same URL construction.
   */
  refToUrl(
    platform: BrowsablePlatform,
    ref: string,
    versionId?: string | null,
  ): string {
    switch (platform) {
      case 'curseforge': {
        const base = `https://www.curseforge.com/minecraft/mc-mods/${ref}`;
        return versionId ? `${base}/files/${versionId}` : base;
      }
      case 'hangar': {
        // Hangar page URLs need the owner: the mod browser's Hangar ref is
        // `owner/slug`, and a bare slug would parse as an owner with no project.
        const base = `https://hangar.papermc.io/${ref}`;
        return versionId
          ? `${base}/versions/${encodeURIComponent(versionId)}`
          : base;
      }
      case 'spiget': {
        const base = `https://www.spigotmc.org/resources/${ref}/`;
        return versionId
          ? `${base}?version=${encodeURIComponent(versionId)}`
          : base;
      }
      case 'modrinth': {
        const base = `https://modrinth.com/mod/${ref}`;
        return versionId ? `${base}/version/${versionId}` : base;
      }
    }
  }

  /**
   * Install content from any source reference (see classifyModSource).
   * Downloads into the library, links into the server dir, and records an
   * overlay row. onProgress passes through to the download.
   */
  async installFromUrl(
    serverId: string,
    input: string,
    {
      actor = 'system',
      kind,
      onProgress,
      importId = null,
    }: {
      actor?: string;
      kind?: ContentKind;
      onProgress?: (...args: unknown[]) => void;
      /** Keep the row attached to its zip / .mrpack import (an update of an imported jar). */
      importId?: string | null;
    } = {},
  ) {
    const server = await this.query.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');
    this.assertAcceptsManualContent(server);
    const targetKind: ContentKind = kind || this.jarKindFor(server);
    const { downloadUrl, meta } = await this.resolveForServer(server, input);
    meta.category = targetKind;

    const lib = await this.library.downloadToLibrary(downloadUrl, meta, {
      onProgress,
      actor,
    });
    const { filename } = await this.addLibraryContent(server, lib, targetKind, {
      importId,
    });
    this.events.recordEvent({
      serverId,
      actor,
      type: 'mod-installed',
      summary: `Custom ${targetKind} installed: ${lib.name}${lib.version ? ` ${lib.version}` : ''} (overlay)`,
      details: { libraryId: lib.id, filename },
    });
    this.scanInBackground();
    return { library: lib, filename };
  }

  /**
   * Finish an add-by-link install that came back blocked (BlockedDownload):
   * the user downloaded the file in a browser and uploads it here, along with
   * the same link. The link is resolved again, so the file's provenance comes
   * from the registry, not from the client. When the registry published a
   * hash (CurseForge), the upload must match it. Otherwise it's taken on the
   * user's word, like any upload. If the link has since become downloadable,
   * the upload is still accepted against the same metadata.
   */
  async installManualUpload(
    serverId: string,
    tmpPath: string,
    origName: string,
    input: string,
    { actor = 'system', kind }: { actor?: string; kind?: ContentKind } = {},
  ): Promise<{ library: LibraryFileRow; filename: string; verified: boolean }> {
    const server = await this.query.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');
    this.assertAcceptsManualContent(server);
    if (!/\.(jar|zip)$/i.test(origName))
      throw new BadRequestException('Only .jar or .zip files can be uploaded');
    const targetKind: ContentKind = kind || this.jarKindFor(server);

    let meta: DownloadMeta;
    try {
      ({ meta } = await this.resolveForServer(server, input));
    } catch (err) {
      if (!(err instanceof BlockedDownloadException)) throw err;
      meta = err.meta;
    }

    const expected = meta.expectedHash ?? null;
    if (expected) {
      const hash = crypto.createHash(expected.algorithm);
      await pipeline(fs.createReadStream(tmpPath), hash);
      const actual = hash.digest('hex');
      if (actual.toLowerCase() !== expected.hex.toLowerCase())
        throw new BadRequestException(
          `That isn't ${meta.filename || `${meta.name} ${meta.version ?? ''}`.trim()}: ` +
            `its ${expected.algorithm} is ${truncateHash(actual)}, the registry says ${truncateHash(expected.hex)}`,
        );
    }

    const lib = await this.library.importFile(
      tmpPath,
      {
        category: targetKind,
        name: meta.name,
        // A verified upload is exactly the registry's file, so it takes the
        // registry's filename (browsers rename duplicates to "x (1).jar").
        filename: (expected && meta.filename) || origName,
        version: meta.version,
      },
      { actor },
    );
    const withProvenance = await this.library.fillMissingProvenance(
      lib.id,
      meta,
    );
    const { filename } = await this.addLibraryContent(
      server,
      withProvenance,
      targetKind,
    );
    this.events.recordEvent({
      serverId,
      actor,
      type: 'mod-installed',
      summary: `Manually downloaded ${targetKind} installed: ${withProvenance.name}${withProvenance.version ? ` ${withProvenance.version}` : ''} (overlay, ${expected ? `${expected.algorithm} verified` : 'unverified'})`,
      details: { libraryId: lib.id, filename, platform: meta.platform },
    });
    this.scanInBackground();
    return { library: withProvenance, filename, verified: Boolean(expected) };
  }

  /**
   * Resolve a reference without installing it, so a caller that removes
   * something first (an update) fails before it does: a missing build, or a
   * BlockedDownloadException. Registry lookups are cached, so the install
   * that follows doesn't repeat them.
   */
  async assertResolvable(serverId: string, input: string): Promise<void> {
    const server = await this.query.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');
    await this.resolveForServer(server, input);
  }

  /**
   * Route a source reference for this server and resolve it to one file:
   * the checks and lookups installFromUrl and installManualUpload share.
   */
  private async resolveForServer(
    server: Server,
    input: string,
  ): Promise<ResolvedDownload> {
    const source = this.classifyModSource(input);
    if (source.kind === 'invalid') {
      throw new BadRequestException(
        'Enter a Modrinth, CurseForge, Hangar, SpigotMC or GitHub link, a GitHub owner/repo, a Modrinth project slug, or a direct download URL',
      );
    }
    if (
      (source.kind === 'hangar' || source.kind === 'spiget') &&
      !PLUGIN_TYPES.has(server.type)
    ) {
      throw new BadRequestException(
        `${source.kind === 'hangar' ? 'Hangar' : 'SpigotMC'} only hosts Paper/Spigot plugins, and this ${server.type} server doesn't load plugins`,
      );
    }
    return this.resolveSource(source, {
      mcVersion:
        server.mc_version === 'LATEST' || server.mc_version === 'SNAPSHOT'
          ? undefined
          : server.mc_version,
      loader: this.loaderOf(server) || undefined,
    });
  }

  private scanInBackground(): void {
    this.indexer
      .scan()
      .catch((err: unknown) =>
        this.logger.warn(
          `background storage-index scan failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }

  /** Turn a classified source into the file to download plus its library metadata. */
  private resolveSource(
    source: ClassifiedModSource,
    target: InstallTarget,
  ): Promise<ResolvedDownload> {
    switch (source.kind) {
      case 'modrinth':
        return this.resolveModrinth(source.ref, target);
      case 'curseforge':
        return this.resolveCurseforge(source.ref, target);
      case 'hangar':
        return this.resolveHangar(source.ref, target);
      case 'spiget':
        return this.resolveSpiget(source.ref);
      case 'github':
        return this.resolveGithub(source.ref);
      case 'direct':
        return Promise.resolve({
          downloadUrl: source.ref,
          meta: { platform: 'url' },
        });
      case 'invalid':
        throw new BadRequestException('Unrecognized content source');
    }
  }

  private async resolveModrinth(
    ref: string,
    { mcVersion, loader }: InstallTarget,
  ): Promise<ResolvedDownload> {
    const resolved = await this.modrinth.resolveUrl(ref);
    const versions = resolved.versionId
      ? [await this.modrinth.getVersion(resolved.versionId)]
      : await this.modrinth.getVersions(resolved.projectId, {
          loader,
          mcVersion,
        });
    if (!versions.length)
      throw new NotFoundException(
        `No ${resolved.title} build matches ${loader || 'this loader'} ${mcVersion || ''}`.trim(),
      );
    const version = versions[0]!;
    const file = this.modrinth.primaryFile(version);
    return {
      downloadUrl: file.url,
      meta: {
        platform: 'modrinth',
        projectId: resolved.projectId,
        fileId: version.id,
        name: resolved.title,
        filename: file.filename,
        version: version.version_number,
        iconUrl: resolved.iconUrl,
        mcVersions: version.game_versions,
        loaders: version.loaders,
        // Modrinth version files always carry hashes.sha512 in practice.
        expectedHash: { algorithm: 'sha512', hex: file.hashes.sha512 },
      },
    };
  }

  private async resolveCurseforge(
    ref: string,
    { mcVersion, loader }: InstallTarget,
  ): Promise<ResolvedDownload> {
    const resolved = await this.curseforge.resolveUrl(ref);
    const file = resolved.fileId
      ? await this.curseforge.getFile(resolved.modId, resolved.fileId)
      : (
          await this.curseforge.getFiles(resolved.modId, { mcVersion, loader })
        )[0];
    if (!file)
      throw new NotFoundException(
        `No ${resolved.name} file matches ${loader || 'this loader'} ${mcVersion || ''}`.trim(),
      );
    const meta: DownloadMeta = {
      platform: 'curseforge',
      projectId: String(resolved.modId),
      fileId: String(file.fileId),
      name: resolved.name,
      filename: file.fileName,
      version: file.name,
      iconUrl: resolved.iconUrl,
      mcVersions: file.gameVersions,
      expectedHash: curseforgeExpectedHash(file),
    };
    // CurseForge's signal for "the author turned off third-party downloads"
    // (the project's allowModDistribution): the file comes back with
    // downloadUrl null. Its hashes are still there, so an upload can be
    // checked against them.
    if (!file.downloadUrl)
      throw new BlockedDownloadException(
        {
          source: 'curseforge',
          reason: 'distribution-disabled',
          name: resolved.name,
          version: file.name,
          filename: file.fileName,
          pageUrl: curseforgePageUrl(resolved, file.fileId),
          externalUrl: null,
          verifiable: Boolean(meta.expectedHash),
        },
        meta,
      );
    return { downloadUrl: file.downloadUrl, meta };
  }

  /**
   * Hangar: a pinned version as-is, otherwise the newest MC-compatible build
   * on the Release channel — many projects (ViaVersion) publish Snapshot
   * builds far more often, so "newest" alone would usually be a snapshot.
   * Falls back to the newest build of any channel when there's no release.
   */
  private async resolveHangar(
    ref: string,
    { mcVersion }: InstallTarget,
  ): Promise<ResolvedDownload> {
    const resolved = await this.hangar.resolveUrl(ref);
    let version: HangarVersion | undefined;
    if (resolved.versionName) {
      version = await this.hangar.getVersion(
        resolved.slug,
        resolved.versionName,
      );
    } else {
      const versions = await this.hangar.getVersions(resolved.slug, {
        mcVersion,
        limit: 50,
      });
      version =
        versions.find((v) => v.versionType === 'release') ?? versions[0];
    }
    if (!version || (!version.downloadUrl && !version.externalUrl))
      throw new NotFoundException(
        version
          ? `${resolved.name} ${version.name} has no Paper build on Hangar`
          : `No ${resolved.name} Paper build matches Minecraft ${mcVersion || '(any version)'}`,
      );
    const meta: DownloadMeta = {
      platform: 'hangar',
      projectId: resolved.slug,
      fileId: version.name,
      name: resolved.name,
      filename: version.filename ?? undefined,
      version: version.name,
      iconUrl: resolved.iconUrl,
      mcVersions: version.gameVersions,
      expectedHash: hangarExpectedHash(version),
    };
    // Externally-hosted builds link to an arbitrary page or file (GitHub
    // release pages, CI servers, Patreon, …) with no hash to check — not
    // something to fetch blind.
    if (!version.downloadUrl)
      throw new BlockedDownloadException(
        {
          source: 'hangar',
          reason: 'external',
          name: resolved.name,
          version: version.name,
          filename: null,
          pageUrl: `https://hangar.papermc.io/${resolved.owner}/${resolved.slug}/versions/${encodeURIComponent(version.name)}`,
          externalUrl: version.externalUrl,
          verifiable: false,
        },
        meta,
      );
    return { downloadUrl: version.downloadUrl, meta };
  }

  /**
   * SpigotMC via Spiget: a pinned `?version=` or the newest build, fetched
   * through Spiget's download proxy. Premium and externally-hosted resources
   * can't be proxied. Spiget publishes no hashes and no per-version MC tags.
   */
  private async resolveSpiget(ref: string): Promise<ResolvedDownload> {
    const resolved = await this.spiget.resolveUrl(ref);
    const lookup = async () =>
      resolved.versionId
        ? await this.spiget.getVersion(resolved.resourceId, resolved.versionId)
        : (await this.spiget.getVersions(resolved.resourceId))[0];
    // A premium/external resource still gets its version looked up, to name
    // what the user should fetch by hand. That's only a label there, so a
    // failed lookup mustn't hide the block.
    const blocked = resolved.premium || resolved.external;
    const version = blocked
      ? await lookup().catch(() => undefined)
      : await lookup();
    // Spiget gives no filename; build a stable one from name + version.
    const slugify = (s: string) =>
      s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
    const meta: DownloadMeta = {
      platform: 'spiget',
      projectId: String(resolved.resourceId),
      fileId: version?.versionId ?? null,
      name: resolved.name,
      filename: version
        ? `${slugify(resolved.name) || `spigot-${resolved.resourceId}`}-${slugify(version.name)}.jar`
        : undefined,
      version: version?.name ?? null,
      iconUrl: resolved.iconUrl,
      // Resource-level "tested versions" — Spiget has nothing per version.
      mcVersions: resolved.testedVersions,
    };
    if (blocked)
      throw new BlockedDownloadException(
        {
          source: 'spiget',
          reason: resolved.premium ? 'premium' : 'external',
          name: resolved.name,
          version: version?.name ?? null,
          filename: null,
          pageUrl: resolved.pageUrl,
          externalUrl: resolved.premium ? null : resolved.externalUrl,
          verifiable: false,
        },
        meta,
      );
    if (!version)
      throw new NotFoundException(
        `${resolved.name} has no downloadable version on SpigotMC`,
      );
    return {
      downloadUrl: this.spiget.downloadUrl(
        resolved.resourceId,
        version.versionId,
      ),
      meta,
    };
  }

  /**
   * GitHub Releases: the pinned tag (and asset) if the link named one,
   * otherwise the newest stable release with a jar. GitHub has no loader or
   * MC metadata, so nothing is filtered by server.
   */
  private async resolveGithub(ref: string): Promise<ResolvedDownload> {
    const resolved = await this.github.resolveUrl(ref);
    const releases = await this.github.getReleases(resolved.repo);
    const release = pickGithubRelease(releases, resolved.tag);
    if (!release)
      throw new NotFoundException(
        resolved.tag
          ? `No release tagged ${resolved.tag} among ${resolved.repo}'s recent releases`
          : `${resolved.repo} has no release with a .jar asset`,
      );
    // A download link names its asset exactly — don't swap in a different jar.
    const asset = resolved.asset
      ? release.assets.find((a) => a.name === resolved.asset)
      : pickGithubAsset(release.assets);
    if (!asset)
      throw new NotFoundException(
        resolved.asset
          ? `Release ${release.tag} of ${resolved.repo} has no .jar asset named ${resolved.asset}`
          : `Release ${release.tag} of ${resolved.repo} has no .jar asset`,
      );
    return {
      downloadUrl: asset.downloadUrl,
      meta: {
        platform: 'github',
        projectId: resolved.repo,
        fileId: release.tag,
        name: resolved.name,
        filename: asset.name,
        version: release.tag,
        iconUrl: resolved.iconUrl,
        expectedHash: githubAssetExpectedHash(asset),
      },
    };
  }

  /** Toggle content. Overlay: rename instantly. Pack: exclusion env + recreate flag. */
  async setEnabled(
    serverId: string,
    file: string,
    enabled: boolean,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<{ applied: 'instant' | 'on-restart' }> {
    this.assertBareContentName(file);
    const server = await this.query.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');
    const [row] = await this.db
      .select()
      .from(serverContent)
      .where(
        and(
          eq(serverContent.serverId, serverId),
          eq(serverContent.filename, file),
        ),
      )
      .limit(1);
    const managedBy = row
      ? row.managedBy
      : this.isPackServer(server)
        ? 'pack'
        : 'overlay';

    if (managedBy === 'overlay' || !this.isPackServer(server)) {
      const dirRel = this.contentDir(
        server,
        (row ? row.kind : 'mod') as ContentKind,
      );
      const base = this.pathGuard.dataPath('servers', serverId, dirRel, file);
      const disabled = `${base}.disabled`;
      if (enabled && fs.existsSync(disabled)) await fsp.rename(disabled, base);
      else if (!enabled && fs.existsSync(base))
        await fsp.rename(base, disabled);
      if (row)
        await this.db
          .update(serverContent)
          .set({ enabled })
          .where(eq(serverContent.id, row.id));
      this.events.recordEvent({
        serverId,
        actor,
        type: enabled ? 'mod-enabled' : 'mod-disabled',
        summary: `${file} ${enabled ? 'enabled' : 'disabled'} (instant)`,
      });
      return { applied: 'instant' };
    }

    // packwiz has no itzg-side exclusion mechanism (unlike CF_EXCLUDE_MODS /
    // MODRINTH_EXCLUDE_FILES) — there is nothing to write to env that would
    // actually stop the pack installer from re-adding the file. Reject
    // explicitly rather than silently writing a useless var.
    if (server.type === 'PACKWIZ') {
      throw new BadRequestException(
        'packwiz-managed mods can’t be toggled from the panel — edit the pack and re-apply the URL instead',
      );
    }

    // Pack-managed: manipulate the exclusion env var. Prefer the real CF project
    // slug/ID from the pack manifest — a name-derived token misses renamed/unofficial
    // mods (e.g. display name "cc tweaked" vs slug "unofficial-cc-tweaked-…"), which
    // silently fails to exclude anything.
    const env = { ...server.env };
    const isCF = server.type === 'AUTO_CURSEFORGE';
    const varName = isCF ? 'CF_EXCLUDE_MODS' : 'MODRINTH_EXCLUDE_FILES';
    const fromManifest = this.manifest
      .index(serverId)
      .get(file.replace(/\.disabled$/, ''));
    const token =
      (fromManifest && (fromManifest.slug || fromManifest.projectId)) ||
      (row && row.iconUrl && row.name
        ? row.name.toLowerCase().replace(/\s+/g, '-')
        : file.replace(/(-[\d.]+.*)?\.jar$/, ''));
    const list = (env[varName] || '')
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const next = enabled
      ? list.filter((t) => t !== token)
      : [...new Set([...list, token])];
    env[varName] = next.join('\n');
    env[isCF ? 'CF_FORCE_SYNCHRONIZE' : 'MODRINTH_FORCE_SYNCHRONIZE'] = 'true';
    await this.lifecycle.updateServer(serverId, { env }, { actor });
    this.events.recordEvent({
      serverId,
      actor,
      type: enabled ? 'mod-enabled' : 'mod-disabled',
      summary: `${file} ${enabled ? 're-included' : 'excluded'} via ${varName} — applies on next restart`,
    });
    return { applied: 'on-restart' };
  }

  /** Remove overlay content (file + row); pack content is excluded, not removed. */
  async removeContent(
    serverId: string,
    file: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<{ freedBytes: number }> {
    this.assertBareContentName(file);
    const server = await this.query.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');
    const [row] = await this.db
      .select()
      .from(serverContent)
      .where(
        and(
          eq(serverContent.serverId, serverId),
          eq(serverContent.filename, file),
        ),
      )
      .limit(1);
    if (row && row.managedBy === 'pack')
      throw new ConflictException(
        'Pack-managed content is excluded, not deleted — use Disable',
      );
    const dirRel = this.contentDir(
      server,
      (row ? row.kind : 'mod') as ContentKind,
    );
    let freed = 0;
    for (const candidate of [file, `${file}.disabled`]) {
      const abs = this.pathGuard.dataPath(
        'servers',
        serverId,
        dirRel,
        candidate,
      );
      if (fs.existsSync(abs)) {
        freed = (await fsp.stat(abs)).size;
        await fsp.rm(abs);
      }
    }
    if (row)
      await this.db.delete(serverContent).where(eq(serverContent.id, row.id));
    this.events.recordEvent({
      serverId,
      actor,
      type: 'mod-removed',
      summary: `Removed ${file} (${(freed / 1024 / 1024).toFixed(1)} MB freed)`,
    });
    return { freedBytes: freed };
  }

  /** Re-apply the overlay after a pack install/update (belt-and-braces). */
  async reapplyOverlay(
    serverId: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<{ restored: number }> {
    const allRows = await this.db
      .select()
      .from(serverContent)
      .where(
        and(
          eq(serverContent.serverId, serverId),
          eq(serverContent.managedBy, 'overlay'),
        ),
      );
    const rows = allRows.filter((r) => r.libraryId != null);
    let restored = 0;
    const serverType = (await this.query.mustGet(serverId)).type;
    for (const row of rows) {
      const dirRel = this.contentDir(
        { type: serverType },
        row.kind as ContentKind,
      );
      const target = this.pathGuard.dataPath(
        'servers',
        serverId,
        dirRel,
        row.enabled ? row.filename : `${row.filename}.disabled`,
      );
      if (!fs.existsSync(target) && !fs.existsSync(`${target}.disabled`)) {
        await this.library.installToServer(row.libraryId!, serverId, dirRel, {
          filename: row.filename,
        });
        if (!row.enabled)
          await fsp.rename(
            this.pathGuard.dataPath('servers', serverId, dirRel, row.filename),
            target,
          );
        restored += 1;
      }
    }
    if (restored > 0) {
      this.events.recordEvent({
        serverId,
        actor,
        type: 'overlay-reapplied',
        summary: `Custom overlay re-applied: ${restored} file(s) restored after pack operation`,
      });
    }
    return { restored };
  }

  private prettifyJarName(file: string): string {
    return (
      file
        .replace(/\.(jar|zip)$/, '')
        .replace(/[-_](\d+\.[\d.]+.*|mc[\d.]+.*|v\d.*)$/i, '')
        .replace(/[-_]+/g, ' ')
        .trim() || file
    );
  }

  // ---------------------------------------------------------------------------
  // Manual-download handling. A CurseForge pack can pin mods whose authors disallow
  // automated download (or that were pulled from CF). mc-image-helper then writes
  // MODS_NEED_DOWNLOAD.txt and the pack install FAILS until each is excluded or
  // supplied by hand — this turns that dead-end into guided actions. Parsing lives
  // in PendingModDownloadsService; these just delegate to keep the public surface.

  /** Mods a CF pack needs supplied by hand, parsed from the server's MODS_NEED_DOWNLOAD.txt. */
  pendingDownloads(serverId: string): PendingDownload[] {
    return this.pendingDownloadsSvc.pendingDownloads(serverId);
  }

  /** The exclusion token (slug preferred) for a pending mod identified by filename. */
  pendingExcludeToken(serverId: string, filename: string): string {
    return this.pendingDownloadsSvc.pendingExcludeToken(serverId, filename);
  }

  /** Drop a resolved mod's line from MODS_NEED_DOWNLOAD.txt (best-effort). */
  clearPendingLine(
    serverId: string,
    filename: string | null | undefined,
  ): void {
    this.pendingDownloadsSvc.clearPendingLine(serverId, filename);
  }

  /** Add a project slug/ID to the pack's exclusion env var (applies on recreate). */
  async excludePackMod(
    serverId: string,
    token: string | null | undefined,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<{ excluded: string }> {
    const server = await this.query.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');
    if (!token) throw new BadRequestException('Nothing to exclude');
    const isCF = server.type === 'AUTO_CURSEFORGE';
    const varName = isCF ? 'CF_EXCLUDE_MODS' : 'MODRINTH_EXCLUDE_FILES';
    const env = { ...server.env };
    const list = (env[varName] || '')
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!list.includes(token)) list.push(token);
    env[varName] = list.join('\n');
    env[isCF ? 'CF_FORCE_SYNCHRONIZE' : 'MODRINTH_FORCE_SYNCHRONIZE'] = 'true';
    await this.lifecycle.updateServer(serverId, { env }, { actor });
    this.events.recordEvent({
      serverId,
      actor,
      type: 'mod-excluded',
      summary: `Excluded pack mod "${token}" via ${varName} — applies on recreate`,
    });
    return { excluded: token };
  }

  /** Install a manually-uploaded jar as an overlay (optionally excluding the pack's copy). */
  async importUploadedMod(
    serverId: string,
    tmpPath: string,
    origName: string | null | undefined,
    {
      excludeToken,
      actor = 'system',
    }: { excludeToken?: string | null; actor?: string } = {},
  ): Promise<{ filename: string; excluded: string | null }> {
    const server = await this.query.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');
    this.assertAcceptsManualContent(server);
    const filename = origName || 'mod.jar';
    if (!/\.(jar|zip)$/i.test(filename))
      throw new BadRequestException('Only .jar or .zip files can be uploaded');
    const targetKind: ContentKind = PLUGIN_TYPES.has(server.type)
      ? 'plugin'
      : 'mod';
    const lib = await this.library.importFile(
      tmpPath,
      { name: this.prettifyJarName(filename), filename, category: targetKind },
      { actor },
    );
    await this.indexer.assertUnderQuota(server, lib.sizeBytes);
    const { filename: installed } = await this.library.installToServer(
      lib.id,
      serverId,
      this.contentDir(server, targetKind),
    );
    await this.db
      .insert(serverContent)
      .values({
        id: `sc_${nanoid(8)}`,
        serverId,
        libraryId: lib.id,
        kind: targetKind,
        managedBy: 'overlay',
        name: lib.name,
        filename: installed,
        version: lib.version,
        iconUrl: lib.iconUrl,
      })
      .onConflictDoUpdate({
        target: [serverContent.serverId, serverContent.filename],
        set: { libraryId: lib.id },
      });
    if (excludeToken)
      await this.excludePackMod(serverId, excludeToken, { actor });
    this.events.recordEvent({
      serverId,
      actor,
      type: 'mod-installed',
      summary: `Uploaded ${targetKind} installed: ${lib.name} (overlay)`,
      details: { filename: installed },
    });
    this.indexer
      .scan()
      .catch((err: unknown) =>
        this.logger.warn(
          `background storage-index scan failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    return { filename: installed, excluded: excludeToken || null };
  }
}
