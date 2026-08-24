import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import { eq, and } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { PathGuardService } from '../storage/path-guard.service';
import { StorageIndexService } from '../storage/storage-index.service';
import { EventsService } from '../events/events.service';
import { LibraryService } from '../library/library.service';
import { ModrinthApiService } from './modrinth-api.service';
import { CurseforgeApiService } from './curseforge-api.service';
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

type ModSourceKind = 'modrinth' | 'curseforge' | 'direct' | 'invalid';

interface ClassifiedModSource {
  kind: ModSourceKind;
  ref: string;
}

@Injectable()
export class ModsService {
  constructor(
    private readonly dbService: DbService,
    private readonly pathGuard: PathGuardService,
    private readonly indexer: StorageIndexService,
    private readonly events: EventsService,
    private readonly library: LibraryService,
    private readonly modrinth: ModrinthApiService,
    private readonly curseforge: CurseforgeApiService,
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
        });
      }
    }
    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Classify an install reference. Pure routing decision, no network.
   *  - modrinth:  modrinth.com page URLs and bare project slugs
   *  - curseforge: curseforge.com page URLs
   *  - direct:    any other URL, INCLUDING cdn.modrinth.com file links —
   *               those are downloads, not project pages
   */
  classifyModSource(input: string | null | undefined): ClassifiedModSource {
    const ref = String(input || '').trim();
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
      return { kind: 'direct', ref };
    }
    // Modrinth slug charset (their documented rule): [\w!@$()`.+,"\-'] ×3–64.
    // \w keeps underscores valid — sodium_extra style slugs used to 500.
    if (/^[\w!@$()`.+,"\-']{3,64}$/.test(ref)) return { kind: 'modrinth', ref };
    return { kind: 'invalid', ref };
  }

  /**
   * Install content from any source reference: direct URL, Modrinth URL/slug,
   * or CurseForge URL. Downloads into the library, links into the server dir,
   * and records an overlay row. onProgress passes through to the download.
   */
  async installFromUrl(
    serverId: string,
    input: string,
    {
      actor = 'system',
      kind,
      onProgress,
    }: {
      actor?: string;
      kind?: ContentKind;
      onProgress?: (...args: unknown[]) => void;
    } = {},
  ) {
    const server = await this.query.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');
    const targetKind: ContentKind =
      kind || (PLUGIN_TYPES.has(server.type) ? 'plugin' : 'mod');
    const mcVersion =
      server.mc_version === 'LATEST' || server.mc_version === 'SNAPSHOT'
        ? undefined
        : server.mc_version;
    const loader = this.loaderOf(server);

    const source = this.classifyModSource(input);
    if (source.kind === 'invalid') {
      throw new BadRequestException(
        'Enter a Modrinth/CurseForge URL, a direct download URL, or a Modrinth project slug',
      );
    }

    let downloadUrl = source.ref;
    const meta: Record<string, unknown> = {
      category: targetKind,
      platform: 'url',
    };

    if (source.kind === 'modrinth') {
      const resolved = await this.modrinth.resolveUrl(source.ref);
      const versions = resolved.versionId
        ? [await this.modrinth.getVersion(resolved.versionId)]
        : await this.modrinth.getVersions(resolved.projectId, {
            loader: loader || undefined,
            mcVersion,
          });
      if (!versions.length)
        throw new NotFoundException(
          `No ${resolved.title} build matches ${loader || 'this loader'} ${mcVersion || ''}`.trim(),
        );
      const version = versions[0]!;
      const file = this.modrinth.primaryFile(version);
      downloadUrl = file.url;
      Object.assign(meta, {
        platform: 'modrinth',
        projectId: resolved.projectId,
        fileId: version.id,
        name: resolved.title,
        filename: file.filename,
        version: version.version_number,
        iconUrl: resolved.iconUrl,
        mcVersions: version.game_versions,
        loaders: version.loaders,
      });
    } else if (source.kind === 'curseforge') {
      const resolved = await this.curseforge.resolveUrl(source.ref);
      const file = resolved.fileId
        ? await this.curseforge.getFile(resolved.modId, resolved.fileId)
        : (
            await this.curseforge.getFiles(resolved.modId, {
              mcVersion,
              loader: loader || undefined,
            })
          )[0];
      if (!file)
        throw new NotFoundException(
          `No ${resolved.name} file matches ${loader || 'this loader'} ${mcVersion || ''}`.trim(),
        );
      if (!file.downloadUrl)
        throw new ConflictException(
          `${resolved.name} disallows automated downloads — download it in a browser and upload the jar instead`,
        );
      downloadUrl = file.downloadUrl;
      Object.assign(meta, {
        platform: 'curseforge',
        projectId: String(resolved.modId),
        fileId: String(file.fileId),
        name: resolved.name,
        filename: file.fileName,
        version: file.name,
        iconUrl: resolved.iconUrl,
        mcVersions: file.gameVersions,
      });
    }
    // source.kind === 'direct' → plain download of the URL as-is.

    const lib = await this.library.downloadToLibrary(downloadUrl, meta, {
      onProgress,
      actor,
    });
    await this.indexer.assertUnderQuota(server, lib.sizeBytes);
    const { filename } = await this.library.installToServer(
      lib.id,
      serverId,
      this.contentDir(server, targetKind),
    );

    const id = `sc_${nanoid(8)}`;
    await this.db
      .insert(serverContent)
      .values({
        id,
        serverId,
        libraryId: lib.id,
        kind: targetKind,
        managedBy: 'overlay',
        name: lib.name,
        filename,
        version: lib.version,
        iconUrl: lib.iconUrl,
      })
      .onConflictDoUpdate({
        target: [serverContent.serverId, serverContent.filename],
        set: { libraryId: lib.id, version: lib.version },
      });
    this.events.recordEvent({
      serverId,
      actor,
      type: 'mod-installed',
      summary: `Custom ${targetKind} installed: ${lib.name}${lib.version ? ` ${lib.version}` : ''} (overlay)`,
      details: { libraryId: lib.id, filename },
    });
    this.indexer.scan().catch(() => {});
    return { library: lib, filename };
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
    this.indexer.scan().catch(() => {});
    return { filename: installed, excluded: excludeToken || null };
  }
}
