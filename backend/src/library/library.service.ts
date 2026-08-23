import { ConflictException, Injectable, BadGatewayException, PayloadTooLargeException, HttpException } from '@nestjs/common';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { nanoid } from 'nanoid';
import { eq, and, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { PathGuardService } from '../storage/path-guard.service';
import { EventsService } from '../events/events.service';
import { StorageIndexService } from '../storage/storage-index.service';
import { ServerEnvironmentService } from '../servers/server-environment.service';
import { safeFetch } from '../utils/url-guard';
import { libraryFiles, serverContent } from '../db/schema';

export type LibraryCategory = 'mod' | 'plugin' | 'datapack' | 'resourcepack' | 'modpack' | 'world' | 'icon';

export const CATEGORY_DIR: Record<LibraryCategory, string> = {
  mod: 'library/mods',
  plugin: 'library/mods',
  datapack: 'library/mods',
  resourcepack: 'library/mods',
  modpack: 'library/modpacks',
  world: 'library/worlds',
  icon: 'library/icons',
};

export interface DownloadMeta {
  category?: LibraryCategory;
  filename?: string;
  name?: string;
  platform?: string;
  projectId?: string | null;
  fileId?: string | null;
  version?: string | null;
  mcVersions?: string[];
  loaders?: string[];
  iconUrl?: string | null;
  worldSource?: string | null;
  worldFlavor?: string | null;
}

export type LibraryFileRow = typeof libraryFiles.$inferSelect;

// No single library download may exceed this — a lying/hostile server can't
// fill the disk through an endless stream.
const MAX_DOWNLOAD_BYTES = 8 * 1024 ** 3;

/**
 * Shared file library (`library_files`): downloads deduplicated by sha256
 * under ./data/library/<kind>/, installed into servers by hard link (falls
 * back to copy across volumes), with locally cached icons.
 */
@Injectable()
export class LibraryService {
  constructor(
    private readonly dbService: DbService,
    private readonly pathGuard: PathGuardService,
    private readonly events: EventsService,
    private readonly storageIndex: StorageIndexService,
    private readonly serverEnv: ServerEnvironmentService
  ) {}

  private get db() {
    return this.dbService.db;
  }

  getLibraryFile(libraryId: string): LibraryFileRow | undefined {
    return this.db.select().from(libraryFiles).where(eq(libraryFiles.id, libraryId)).get();
  }

  usageCount(libraryId: string): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(serverContent)
      .where(eq(serverContent.libraryId, libraryId))
      .get();
    return Number(row?.n || 0);
  }

  async deleteLibraryFile(
    libraryId: string,
    { actor = 'system', force = false }: { actor?: string; force?: boolean } = {}
  ): Promise<{ freedBytes: number }> {
    const lib = this.db.select().from(libraryFiles).where(eq(libraryFiles.id, libraryId)).get();
    if (!lib) return { freedBytes: 0 };
    const used = this.usageCount(libraryId);
    if (used > 0 && !force) throw new ConflictException(`Still installed on ${used} server(s) — remove it there first`);
    await fsp.rm(this.pathGuard.dataPath(lib.relPath), { force: true });
    if (lib.iconRelPath) await fsp.rm(this.pathGuard.dataPath(lib.iconRelPath), { force: true });
    this.db.delete(libraryFiles).where(eq(libraryFiles.id, libraryId)).run();
    this.events.recordEvent({
      actor,
      type: 'library-deleted',
      summary: `Removed from library: ${lib.name} (${humanBytes(lib.sizeBytes)} freed)`,
    });
    return { freedBytes: lib.sizeBytes };
  }

  /** Library rows whose files no other record references — cleanup candidates. */
  orphans() {
    return this.db
      .select()
      .from(libraryFiles)
      .leftJoin(serverContent, eq(serverContent.libraryId, libraryFiles.id))
      .where(
        and(
          sql`${serverContent.id} IS NULL`,
          sql`${libraryFiles.category} IN ('mod','plugin','datapack','resourcepack')`
        )
      )
      .all()
      .map((r) => r.library_files);
  }

  /**
   * Download a URL into the library with hash dedupe.
   * onProgress({receivedBytes, totalBytes}) fires during download.
   * Returns the library_files row (existing row when the hash already exists).
   */
  async downloadToLibrary(
    url: string,
    meta: DownloadMeta,
    {
      onProgress = () => {},
      actor = 'system',
    }: { onProgress?: (progress: { receivedBytes: number; totalBytes: number }) => void; actor?: string } = {}
  ): Promise<LibraryFileRow> {
    const category = meta.category || 'mod';
    const tmpFile = this.pathGuard.dataPath('tmp', `dl-${nanoid(6)}`);
    // SSRF-guarded: rejects private/loopback/link-local targets and re-checks every
    // redirect hop, so a user-supplied "direct" URL can't reach internal services.
    const res = await safeFetch(url, {
      headers: { 'User-Agent': 'MinecraftServerManager/0.1' },
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    if (!res.ok) throw new BadGatewayException(`Download failed: HTTP ${res.status} from ${new URL(url).host}`);
    const totalBytes = Number(res.headers.get('content-length')) || 0;

    // Disk preflight when the server declares a size (tmp copy + final copy).
    if (totalBytes > 0) {
      if (totalBytes > MAX_DOWNLOAD_BYTES) {
        throw new PayloadTooLargeException(
          `Download is ${humanBytes(totalBytes)} — the ${humanBytes(MAX_DOWNLOAD_BYTES)} per-file limit blocks it`
        );
      }
      const { free } = await this.storageIndex.diskFree();
      if (free < totalBytes * 1.2) {
        throw new HttpException(`Not enough disk space for this download (~${humanBytes(totalBytes)} needed)`, 507);
      }
    }

    const hash = crypto.createHash('sha256');
    let receivedBytes = 0;
    const { Transform } = await import('node:stream');
    const counter = new Transform({
      transform(chunk: Buffer, _enc: string, cb: (err?: Error | null, chunk?: Buffer) => void) {
        hash.update(chunk);
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_DOWNLOAD_BYTES) {
          // Hard abort — content-length can lie or be absent entirely.
          return cb(new PayloadTooLargeException(`Download aborted: stream exceeded the ${humanBytes(MAX_DOWNLOAD_BYTES)} per-file limit`));
        }
        onProgress({ receivedBytes, totalBytes });
        cb(null, chunk);
      },
    });
    try {
      await pipeline(res.body as unknown as NodeJS.ReadableStream, counter, fs.createWriteStream(tmpFile));
    } catch (err) {
      await fsp.rm(tmpFile, { force: true }).catch(() => {});
      throw err;
    }

    const sha256 = hash.digest('hex');
    const existing = this.db.select().from(libraryFiles).where(and(eq(libraryFiles.sha256, sha256), eq(libraryFiles.category, category))).get();
    if (existing) {
      await fsp.rm(tmpFile, { force: true });
      return existing;
    }

    const filename = sanitizeFilename(meta.filename || decodeURIComponent(path.basename(new URL(url).pathname)) || `file-${sha256.slice(0, 8)}`);
    const relPath = `${CATEGORY_DIR[category]}/${sha256.slice(0, 8)}-${filename}`;
    await fsp.mkdir(path.dirname(this.pathGuard.dataPath(relPath)), { recursive: true });
    await fsp.rename(tmpFile, this.pathGuard.dataPath(relPath));
    const size = (await fsp.stat(this.pathGuard.dataPath(relPath))).size;

    const id = `lib_${nanoid(8)}`;
    // onConflictDoNothing closes the check-then-insert race: if a concurrent add for
    // the same (sha256, category) won, our INSERT no-ops (relPath is derived from the
    // sha, so both point at the identical file — nothing to clean up) and we return theirs.
    this.db
      .insert(libraryFiles)
      .values({
        id,
        category,
        name: meta.name || filename,
        filename,
        relPath,
        sha256,
        sizeBytes: size,
        sourceUrl: url,
        platform: meta.platform || 'url',
        projectId: meta.projectId || null,
        fileId: meta.fileId || null,
        version: meta.version || null,
        mcVersionsJson: JSON.stringify(meta.mcVersions || []),
        loadersJson: JSON.stringify(meta.loaders || []),
        iconUrl: meta.iconUrl || null,
        worldSource: meta.worldSource || null,
        worldFlavor: meta.worldFlavor || null,
      })
      .onConflictDoNothing({ target: [libraryFiles.sha256, libraryFiles.category] })
      .run();
    const row = this.db.select().from(libraryFiles).where(and(eq(libraryFiles.sha256, sha256), eq(libraryFiles.category, category))).get()!;
    if (row.id === id) {
      // We won the insert — do the one-time side effects.
      if (meta.iconUrl) this.cacheIcon(id, meta.iconUrl).catch(() => {});
      this.events.recordEvent({
        actor,
        type: 'library-added',
        summary: `Added to library: ${meta.name || filename} (${humanBytes(size)})`,
        details: { id, category, sha256 },
      });
    }
    return row;
  }

  /** Cache a mod's platform icon locally so the UI never hotlinks. */
  async cacheIcon(libraryId: string, iconUrl: string): Promise<void> {
    try {
      const res = await safeFetch(iconUrl, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return;
      const ext = path.extname(new URL(iconUrl).pathname) || '.png';
      const rel = `library/icons/mods/${libraryId}${ext}`;
      await fsp.mkdir(path.dirname(this.pathGuard.dataPath(rel)), { recursive: true });
      await pipeline(res.body as unknown as NodeJS.ReadableStream, fs.createWriteStream(this.pathGuard.dataPath(rel)));
      this.db.update(libraryFiles).set({ iconRelPath: rel }).where(eq(libraryFiles.id, libraryId)).run();
    } catch {
      /* icons are best-effort */
    }
  }

  /**
   * Install a library file into a server directory (hard link → copy fallback).
   * destRel example: 'mods' | 'plugins' | 'world/datapacks'.
   */
  async installToServer(
    libraryId: string,
    serverId: string,
    destRel: string,
    { filename }: { filename?: string } = {}
  ): Promise<{ installedPath: string; filename: string }> {
    const lib = this.db.select().from(libraryFiles).where(eq(libraryFiles.id, libraryId)).get();
    if (!lib) throw new ConflictException('Library file not found');
    // The panel must own the server dir to write into it — a server created before
    // container-runs-as-panel-user has files owned by uid 1000.
    await this.serverEnv.ensureOwnership(serverId);
    const destDir = this.pathGuard.dataPath('servers', serverId, destRel);
    await fsp.mkdir(destDir, { recursive: true });
    const target = path.join(destDir, sanitizeFilename(filename || lib.filename));
    await fsp.rm(target, { force: true });
    try {
      await fsp.link(this.pathGuard.dataPath(lib.relPath), target);
    } catch {
      await fsp.copyFile(this.pathGuard.dataPath(lib.relPath), target);
    }
    return { installedPath: target, filename: path.basename(target) };
  }

  /**
   * Import a locally-uploaded file (e.g. a manually-downloaded mod jar) into the
   * library with sha256 dedupe. Mirrors downloadToLibrary but from a local path.
   */
  async importFile(localPath: string, meta: DownloadMeta, { actor = 'system' }: { actor?: string } = {}): Promise<LibraryFileRow> {
    const category = meta.category || 'mod';
    const buf = await fsp.readFile(localPath);
    if (buf.length > MAX_DOWNLOAD_BYTES) throw new PayloadTooLargeException('File is too large');
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const existing = this.db.select().from(libraryFiles).where(and(eq(libraryFiles.sha256, sha256), eq(libraryFiles.category, category))).get();
    if (existing) return existing;
    const filename = sanitizeFilename(meta.filename || path.basename(localPath));
    const relPath = `${CATEGORY_DIR[category]}/${sha256.slice(0, 8)}-${filename}`;
    await fsp.mkdir(path.dirname(this.pathGuard.dataPath(relPath)), { recursive: true });
    await fsp.writeFile(this.pathGuard.dataPath(relPath), buf);
    const id = `lib_${nanoid(8)}`;
    this.db
      .insert(libraryFiles)
      .values({
        id,
        category,
        name: meta.name || filename,
        filename,
        relPath,
        sha256,
        sizeBytes: buf.length,
        sourceUrl: null,
        platform: meta.platform || 'upload',
        projectId: null,
        fileId: null,
        version: meta.version || null,
        mcVersionsJson: '[]',
        loadersJson: '[]',
        iconUrl: null,
        worldSource: null,
        worldFlavor: null,
      })
      .onConflictDoNothing({ target: [libraryFiles.sha256, libraryFiles.category] })
      .run();
    const row = this.db.select().from(libraryFiles).where(and(eq(libraryFiles.sha256, sha256), eq(libraryFiles.category, category))).get()!;
    if (row.id === id) {
      this.events.recordEvent({
        actor,
        type: 'library-added',
        summary: `Uploaded to library: ${meta.name || filename} (${humanBytes(buf.length)})`,
        details: { id, category, sha256 },
      });
    }
    return row;
  }
}

export function humanBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

export function sanitizeFilename(name: string): string {
  return String(name)
    .replace(/[\\/:*?"<>|\0]/g, '_')
    .slice(0, 180);
}
