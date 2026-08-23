import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import { eq, and } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { EventsService } from '../events/events.service';
import { PathGuardService } from '../storage/path-guard.service';
import { StorageIndexService } from '../storage/storage-index.service';
import { ServerQueryService } from '../servers/server-query.service';
import { ServerLifecycleService, type CreateServerInput } from '../servers/server-lifecycle.service';
import type { Server } from '../servers/types';
import { PacksService } from '../packs/packs.service';
import { LibraryService, CATEGORY_DIR, type LibraryCategory, type DownloadMeta } from '../library/library.service';
import { ModsService } from '../mods/mods.service';
import { ModrinthApiService } from '../mods/modrinth-api.service';
import { CurseforgeApiService } from '../mods/curseforge-api.service';
import { blueprints, libraryFiles, serverContent } from '../db/schema';
import { extractZipSafe, hashFile, readZipIndex, sanitizeFilename } from './zip.util';
import {
  KNOWN_TYPES,
  manifestSchema,
  type BlueprintManifest,
  type ImportOverrides,
  type ImportPreviewResult,
  type ImportReportItem,
  type OverlayEntry,
} from './blueprints.types';
import { BlueprintExportService } from './blueprint-export.service';

/** Validate and apply `.mcserver.zip` blueprints — turns a manifest back into a running server. */
@Injectable()
export class BlueprintImportService {
  constructor(
    private readonly dbService: DbService,
    private readonly events: EventsService,
    private readonly pathGuard: PathGuardService,
    private readonly storageIndex: StorageIndexService,
    private readonly serverQuery: ServerQueryService,
    private readonly lifecycle: ServerLifecycleService,
    private readonly packs: PacksService,
    private readonly library: LibraryService,
    private readonly mods: ModsService,
    private readonly modrinth: ModrinthApiService,
    private readonly curseforge: CurseforgeApiService,
    private readonly exportService: BlueprintExportService
  ) {}

  private get db() {
    return this.dbService.db;
  }

  /**
   * Validate a .mcserver.zip and return { manifest, warnings, entries }.
   * Rejects zip-slip entry names and schema violations before anything is created.
   */
  async importPreview(zipPath: string): Promise<ImportPreviewResult> {
    const { entries, manifestText } = await readZipIndex(zipPath);
    if (!manifestText) throw new BadRequestException('Not a Minecraft Server Manager blueprint: manifest.json is missing');

    let raw: unknown;
    try {
      raw = JSON.parse(manifestText);
    } catch {
      throw new BadRequestException('Blueprint manifest is not valid JSON');
    }
    const parsed = manifestSchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new BadRequestException(`Blueprint manifest failed validation — ${detail}`);
    }
    const manifest: BlueprintManifest = parsed.data;
    for (const rel of manifest.configFiles) {
      if (rel.split('/').includes('..') || path.isAbsolute(rel)) {
        throw new BadRequestException(`Blueprint config file path escapes the server directory: ${rel}`);
      }
    }

    const entryNames = new Set(entries.map((e) => e.name));
    const warnings: string[] = [];
    if (!KNOWN_TYPES.has(manifest.config.type)) {
      warnings.push(`Unknown server type "${manifest.config.type}" — this panel may not know how to run it.`);
    }
    const mcMatch = /^1\.(\d+)/.exec(manifest.config.mcVersion);
    if (mcMatch && Number(mcMatch[1]) < 13) {
      warnings.push(`Minecraft ${manifest.config.mcVersion} is very old — expect Java and mod availability quirks.`);
    }
    if (manifest.embedFiles) {
      const missing = manifest.overlay.filter((o) => o.filename && !entryNames.has(`payload/overlay/${o.filename}`));
      if (missing.length)
        warnings.push(`${missing.length} embedded overlay file(s) are missing from the archive — they will be downloaded instead.`);
    }
    for (const entry of manifest.overlay) {
      if (!entry.sourceUrl && !(entry.filename && entryNames.has(`payload/overlay/${entry.filename}`))) {
        warnings.push(`"${entry.name}" has no source URL and no embedded file — it cannot be installed.`);
      }
      if (!entry.sha256) {
        warnings.push(`"${entry.name}" carries no hash — its download will not be verified.`);
      }
    }
    if (manifest.world && !entries.some((e) => e.name.startsWith('payload/world/'))) {
      warnings.push('The manifest claims a world is included but the archive has no world payload.');
    }
    if (manifest.pack && manifest.pack.platform === 'curseforge') {
      warnings.push('CurseForge pack — a CurseForge API key must be configured in Settings for the install to work.');
    }

    return {
      manifest,
      warnings,
      entries: {
        count: entries.length,
        payloadBytes: entries.filter((e) => e.name.startsWith('payload/')).reduce((n, e) => n + e.size, 0),
      },
    };
  }

  /**
   * Create a NEW server from a blueprint. `zipRef` is a blueprint id (bp_…) or a
   * zip path inside the data dir. Fresh ports and RCON password are always
   * assigned; identity/resources come from the manifest unless overridden.
   * Returns { server, report } — report has one {name, status, error?} per
   * pack/overlay item ('ok' | 'hash-mismatch' | 'failed'); failures never abort
   * the rest of the import.
   */
  async importBlueprint(
    zipRef: string,
    overrides: ImportOverrides = {},
    { actor = 'system', onProgress = (_msg: string) => {} }: { actor?: string; onProgress?: (msg: string) => void } = {}
  ): Promise<{ server: Server | null; report: ImportReportItem[] }> {
    let zipPath = zipRef;
    if (/^bp_/.test(zipRef)) {
      zipPath = await this.getBlueprintPath(zipRef);
    }
    if (!fs.existsSync(zipPath)) throw new NotFoundException('Blueprint archive not found');

    const { manifest, entries } = await this.importPreview(zipPath);
    const o = overrides || {};

    onProgress('Creating server…');
    const createInput: CreateServerInput = {
      name: o.name || manifest.identity.name || manifest.name,
      description: o.description !== undefined ? o.description : manifest.identity.description,
      icon: o.icon || manifest.identity.icon,
      accent: o.accent || manifest.identity.accent,
      tags: o.tags || manifest.identity.tags,
      type: manifest.config.type,
      mcVersion: o.mcVersion || manifest.config.mcVersion,
      javaTag: manifest.config.javaTag,
      env: this.exportService.sanitizeEnv(manifest.config.env),
      heapMb: o.heapMb ?? manifest.resources.heapMb,
      containerMemoryMb: o.containerMemoryMb ?? manifest.resources.containerMemoryMb,
      cpus: o.cpus ?? manifest.resources.cpus,
      diskQuotaGb: o.diskQuotaGb ?? manifest.resources.diskQuotaGb,
      updatePolicy: manifest.resources.updatePolicy,
      containerName: o.containerName,
      networkName: o.networkName,
      extraPorts: o.extraPorts as CreateServerInput['extraPorts'],
      extraBinds: o.extraBinds as CreateServerInput['extraBinds'],
    };
    const server = await this.lifecycle.createServer(createInput, { actor, start: false, onProgress });
    if (manifest.resources.quotaStrict) {
      await this.lifecycle.updateServer(server.id, { quotaStrict: true }, { actor });
    }

    const report: ImportReportItem[] = [];
    const hasPayload = entries.payloadBytes > 0;
    const tmpDir = this.pathGuard.dataPath('tmp', `bpimp-${nanoid(8)}`);

    try {
      if (hasPayload) {
        onProgress('Extracting blueprint payload…');
        await extractZipSafe(zipPath, tmpDir);
      }

      // Pinned modpack
      if (manifest.pack) {
        onProgress(`Installing pinned pack: ${manifest.pack.projectName || manifest.pack.projectRef}…`);
        try {
          const resolved = await this.packs.resolvePack(manifest.pack.platform, manifest.pack.projectRef, {
            versionId: manifest.pack.versionId,
          });
          await this.packs.applyPack(server.id, resolved, { actor });
          report.push({ name: `Modpack: ${resolved.projectName} @ ${resolved.versionName}`, status: 'ok' });
        } catch (err) {
          report.push({
            name: `Modpack: ${manifest.pack.projectName || manifest.pack.projectRef}`,
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Custom overlay: embedded payload first, else re-download + hash verify.
      const freshServer = await this.serverQuery.mustGet(server.id);
      for (let i = 0; i < manifest.overlay.length; i += 1) {
        const entry = manifest.overlay[i];
        if (!entry) continue;
        onProgress(`Overlay ${i + 1}/${manifest.overlay.length}: ${entry.name}…`);
        report.push(await this.installOverlayItem(entry, freshServer, tmpDir, { actor }));
      }

      // Config files payload → server dir (paths re-guarded against the server dir).
      for (const rel of manifest.configFiles) {
        const src = path.join(tmpDir, 'payload', 'config', rel);
        if (!fs.existsSync(src)) continue;
        const dest = this.pathGuard.safeJoin(this.pathGuard.dataPath('servers', server.id), rel);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.copyFile(src, dest);
      }

      // World payload → server dir (dir names come from the extracted tree).
      const worldPayload = path.join(tmpDir, 'payload', 'world');
      if (manifest.world && fs.existsSync(worldPayload)) {
        onProgress('Installing world…');
        await fsp.cp(worldPayload, this.pathGuard.dataPath('servers', server.id), { recursive: true, force: true });
      }
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }

    const failed = report.filter((r) => r.status !== 'ok').length;
    this.events.recordEvent({
      serverId: server.id,
      actor,
      type: 'blueprint-imported',
      summary: `Server created from blueprint "${manifest.name}"${report.length ? ` — ${report.length - failed}/${report.length} items ok` : ''}`,
      details: { blueprint: manifest.name, report },
    });
    this.storageIndex.scan().catch(() => {});
    return { server: await this.serverQuery.getServer(server.id), report };
  }

  /** One overlay item → {name, status: 'ok'|'hash-mismatch'|'failed', error?}. */
  private async installOverlayItem(entry: OverlayEntry, server: Server, tmpDir: string, { actor }: { actor: string }): Promise<ImportReportItem> {
    const dirRel = this.mods.contentDir(server, entry.kind);
    try {
      let lib;
      const embedded = entry.filename ? path.join(tmpDir, 'payload', 'overlay', entry.filename) : null;
      if (embedded && fs.existsSync(embedded)) {
        const sha256 = await hashFile(embedded);
        if (entry.sha256 && sha256 !== entry.sha256) {
          return { name: entry.name, status: 'hash-mismatch', error: `Embedded file hash ${sha256.slice(0, 12)}… does not match the manifest` };
        }
        lib = await this.ingestLocalFile(embedded, entry, sha256);
      } else {
        const { url, meta } = await this.resolveOverlaySource(entry, server);
        lib = await this.library.downloadToLibrary(url, { ...meta, category: entry.kind, name: entry.name }, { actor });
        if (entry.sha256 && lib.sha256 !== entry.sha256) {
          return { name: entry.name, status: 'hash-mismatch', error: `Downloaded file hash ${lib.sha256.slice(0, 12)}… does not match the manifest` };
        }
      }
      if (!lib) throw new Error('Overlay item could not be resolved to a library file');
      const { filename } = await this.library.installToServer(lib.id, server.id, dirRel);
      await this.db
        .insert(serverContent)
        .values({
          id: `sc_${nanoid(8)}`,
          serverId: server.id,
          libraryId: lib.id,
          kind: entry.kind,
          managedBy: 'overlay',
          name: entry.name,
          filename,
          version: lib.version || entry.version,
          iconUrl: lib.iconUrl || null,
        })
        .onConflictDoUpdate({
          target: [serverContent.serverId, serverContent.filename],
          set: { libraryId: lib.id, version: lib.version || entry.version },
        });
      return { name: entry.name, status: 'ok' };
    } catch (err) {
      return { name: entry.name, status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Turn an overlay manifest entry into a direct download URL + library meta. */
  private async resolveOverlaySource(entry: OverlayEntry, server: Server): Promise<{ url: string; meta: DownloadMeta }> {
    const loader = this.mods.loaderOf(server);
    const mcVersion = ['LATEST', 'SNAPSHOT'].includes(server.mc_version) ? undefined : server.mc_version;

    // Exact pinned file when the platform ids are recorded.
    if (entry.platform === 'modrinth' && entry.fileId) {
      const version = await this.modrinth.getVersion(entry.fileId);
      const file = this.modrinth.primaryFile(version);
      return {
        url: file.url,
        meta: {
          platform: 'modrinth',
          projectId: entry.projectId,
          fileId: entry.fileId,
          filename: file.filename,
          version: version.version_number,
          mcVersions: version.game_versions,
          loaders: version.loaders,
        },
      };
    }
    if (entry.platform === 'curseforge' && entry.projectId && entry.fileId) {
      const file = await this.curseforge.getFile(Number(entry.projectId), Number(entry.fileId));
      if (!file || !file.downloadUrl) throw new ConflictException(`${entry.name} disallows automated downloads — install it manually`);
      return {
        url: file.downloadUrl,
        meta: {
          platform: 'curseforge',
          projectId: entry.projectId,
          fileId: entry.fileId,
          filename: file.fileName,
          version: file.name,
          mcVersions: file.gameVersions,
        },
      };
    }
    // Platform project page (starter blueprints): resolve the best build for
    // this server's loader + MC version at import time.
    if (entry.sourceUrl && /modrinth\.com\//.test(entry.sourceUrl)) {
      const project = await this.modrinth.resolveUrl(entry.sourceUrl);
      const versions = await this.modrinth.getVersions(project.projectId, { loader: loader ?? undefined, mcVersion });
      if (!versions.length) throw new NotFoundException(`No ${project.title} build matches ${loader || 'this loader'} ${mcVersion || 'this version'}`);
      const version = versions[0]!;
      const file = this.modrinth.primaryFile(version);
      return {
        url: file.url,
        meta: {
          platform: 'modrinth',
          projectId: project.projectId,
          fileId: version.id,
          filename: file.filename,
          version: version.version_number,
          iconUrl: project.iconUrl,
          mcVersions: version.game_versions,
          loaders: version.loaders,
        },
      };
    }
    if (entry.sourceUrl) {
      return { url: entry.sourceUrl, meta: { platform: 'url', filename: entry.filename || undefined, version: entry.version || undefined } };
    }
    throw new BadRequestException('No embedded file and no source URL — nothing to install from');
  }

  /** Register an extracted payload file in the shared library (dedupe by hash). */
  private async ingestLocalFile(absFile: string, entry: OverlayEntry, sha256: string) {
    const category = (entry.kind || 'mod') as LibraryCategory;
    const [existing] = await this.db.select().from(libraryFiles).where(and(eq(libraryFiles.sha256, sha256), eq(libraryFiles.category, category))).limit(1);
    if (existing) return existing;
    const filename = sanitizeFilename(entry.filename || path.basename(absFile));
    const relPath = `${CATEGORY_DIR[category]}/${sha256.slice(0, 8)}-${filename}`;
    await fsp.mkdir(path.dirname(this.pathGuard.dataPath(relPath)), { recursive: true });
    await fsp.copyFile(absFile, this.pathGuard.dataPath(relPath));
    const size = (await fsp.stat(this.pathGuard.dataPath(relPath))).size;
    const id = `lib_${nanoid(8)}`;
    // onConflictDoNothing: a concurrent ingest of the same file no-ops here
    // (shared relPath), and we return whichever row exists for this (sha256, category).
    await this.db
      .insert(libraryFiles)
      .values({
        id,
        category,
        name: entry.name,
        filename,
        relPath,
        sha256,
        sizeBytes: size,
        sourceUrl: entry.sourceUrl,
        platform: entry.platform || 'blueprint',
        projectId: entry.projectId,
        fileId: entry.fileId,
        version: entry.version,
      })
      .onConflictDoNothing({ target: [libraryFiles.sha256, libraryFiles.category] });
    const [row] = await this.db.select().from(libraryFiles).where(and(eq(libraryFiles.sha256, sha256), eq(libraryFiles.category, category))).limit(1);
    return row!;
  }

  /** One-click duplicate: full export (embedded files) + immediate import. */
  async cloneServer(
    serverId: string,
    { includeWorld = false, actor = 'system', onProgress = (_msg: string) => {} }: { includeWorld?: boolean; actor?: string; onProgress?: (msg: string) => void } = {}
  ) {
    const original = await this.serverQuery.getServer(serverId);
    if (!original) throw new NotFoundException('Server not found');
    onProgress('Exporting blueprint…');
    const blueprint = await this.exportService.exportBlueprint(serverId, { includeConfig: true, embedFiles: true, includeWorld }, { actor });
    const { server, report } = await this.importBlueprint(blueprint.id, { name: `${original.display_name} (copy)` }, { actor, onProgress });
    return { server, report, blueprint };
  }

  async getBlueprintPath(id: string): Promise<string> {
    const [row] = await this.db.select().from(blueprints).where(eq(blueprints.id, id)).limit(1);
    if (!row) throw new NotFoundException('Blueprint not found');
    return this.pathGuard.dataPath(row.relPath);
  }
}
