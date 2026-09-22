import {
  ConflictException,
  Injectable,
  Logger,
  BadGatewayException,
  PayloadTooLargeException,
  HttpException,
} from '@nestjs/common';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { nanoid } from 'nanoid';
import { eq, and, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { PathGuardService } from '../storage/path-guard.service';
import { EventsService } from '../events/events.service';
import { StorageIndexService } from '../storage/storage-index.service';
import { ServerEnvironmentService } from '../servers/server-environment.service';
import { libraryFiles, serverContent } from '../db/schema';
import type { ExpectedHash } from '../mods/mods.types';

export type LibraryCategory =
  'mod' | 'plugin' | 'datapack' | 'resourcepack' | 'modpack' | 'world' | 'icon';

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
  /**
   * Registry-published checksum for this download (Modrinth `hashes.sha512`,
   * CurseForge `hashes[]`, a packwiz index entry's `hash`/`hash-format`, …).
   * When present, verified against the downloaded bytes before the file is
   * trusted/committed to the library — see downloadToLibrary's "Integrity
   * verification" step and LIBRARY_NOTES.md.
   */
  expectedHash?: ExpectedHash | null;
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
  private readonly logger = new Logger(LibraryService.name);

  constructor(
    private readonly dbService: DbService,
    private readonly pathGuard: PathGuardService,
    private readonly events: EventsService,
    private readonly storageIndex: StorageIndexService,
    private readonly serverEnv: ServerEnvironmentService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  async getLibraryFile(libraryId: string): Promise<LibraryFileRow | undefined> {
    const [row] = await this.db
      .select()
      .from(libraryFiles)
      .where(eq(libraryFiles.id, libraryId))
      .limit(1);
    return row;
  }

  async usageCount(libraryId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(serverContent)
      .where(eq(serverContent.libraryId, libraryId));
    return Number(row?.n || 0);
  }

  async deleteLibraryFile(
    libraryId: string,
    {
      actor = 'system',
      force = false,
    }: { actor?: string; force?: boolean } = {},
  ): Promise<{ freedBytes: number }> {
    const [lib] = await this.db
      .select()
      .from(libraryFiles)
      .where(eq(libraryFiles.id, libraryId))
      .limit(1);
    if (!lib) return { freedBytes: 0 };
    const used = await this.usageCount(libraryId);
    if (used > 0 && !force)
      throw new ConflictException(
        `Still installed on ${used} server(s) — remove it there first`,
      );
    await fsp.rm(this.pathGuard.dataPath(lib.relPath), { force: true });
    if (lib.iconRelPath)
      await fsp.rm(this.pathGuard.dataPath(lib.iconRelPath), { force: true });
    await this.db.delete(libraryFiles).where(eq(libraryFiles.id, libraryId));
    this.events.recordEvent({
      actor,
      type: 'library-deleted',
      summary: `Removed from library: ${lib.name} (${humanBytes(lib.sizeBytes)} freed)`,
    });
    return { freedBytes: lib.sizeBytes };
  }

  /** Library rows whose files no other record references — cleanup candidates. */
  async orphans() {
    const rows = await this.db
      .select()
      .from(libraryFiles)
      .leftJoin(serverContent, eq(serverContent.libraryId, libraryFiles.id))
      .where(
        and(
          sql`${serverContent.id} IS NULL`,
          sql`${libraryFiles.category} IN ('mod','plugin','datapack','resourcepack')`,
        ),
      );
    return rows.map((r) => r.library_files);
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
    }: {
      onProgress?: (progress: {
        receivedBytes: number;
        totalBytes: number;
      }) => void;
      actor?: string;
    } = {},
  ): Promise<LibraryFileRow> {
    const category = meta.category || 'mod';
    const tmpFile = this.pathGuard.dataPath('tmp', `dl-${nanoid(6)}`);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'MinecraftServerManager/0.1' },
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
    if (!res.ok)
      throw new BadGatewayException(
        `Download failed: HTTP ${res.status} from ${new URL(url).host}`,
      );
    const totalBytes = Number(res.headers.get('content-length')) || 0;

    // Disk preflight when the server declares a size (tmp copy + final copy).
    if (totalBytes > 0) {
      if (totalBytes > MAX_DOWNLOAD_BYTES) {
        throw new PayloadTooLargeException(
          `Download is ${humanBytes(totalBytes)} — the ${humanBytes(MAX_DOWNLOAD_BYTES)} per-file limit blocks it`,
        );
      }
      const { free } = await this.storageIndex.diskFree();
      if (free < totalBytes * 1.2) {
        throw new HttpException(
          `Not enough disk space for this download (~${humanBytes(totalBytes)} needed)`,
          507,
        );
      }
    }

    const expectedHash = meta.expectedHash ?? null;
    if (!expectedHash) {
      // Not every source publishes a checksum up front (a plain direct-URL
      // install has none to give us) — skip verification rather than hard
      // failing every download that lacks one. See LIBRARY_NOTES.md.
      this.logger.warn(
        `Downloading "${meta.name || url}" with no registry-published checksum to verify against — integrity of this download is unverified`,
      );
    }
    const hash = crypto.createHash('sha256');
    // Only allocate a second hash instance when verification needs an
    // algorithm other than the sha256 we already compute for dedupe.
    const verifyHash =
      expectedHash && expectedHash.algorithm !== 'sha256'
        ? crypto.createHash(expectedHash.algorithm)
        : null;
    let receivedBytes = 0;
    const counter = new Transform({
      transform(
        chunk: Buffer,
        _enc: string,
        cb: (err?: Error | null, chunk?: Buffer) => void,
      ) {
        hash.update(chunk);
        verifyHash?.update(chunk);
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_DOWNLOAD_BYTES) {
          // Hard abort — content-length can lie or be absent entirely.
          return cb(
            new PayloadTooLargeException(
              `Download aborted: stream exceeded the ${humanBytes(MAX_DOWNLOAD_BYTES)} per-file limit`,
            ),
          );
        }
        onProgress({ receivedBytes, totalBytes });
        cb(null, chunk);
      },
    });
    try {
      await pipeline(
        res.body as unknown as NodeJS.ReadableStream,
        counter,
        fs.createWriteStream(tmpFile),
      );
    } catch (err) {
      await fsp.rm(tmpFile, { force: true }).catch(() => {});
      throw err;
    }

    const sha256 = hash.digest('hex');

    // Integrity verification: compare the bytes we actually received
    // against the checksum the registry published for this file, BEFORE
    // the file is dedupe-checked, moved into the library, or installed
    // anywhere. This is content-integrity only — it does not vet the
    // download URL/host itself (see LIBRARY_NOTES.md: that guard was
    // deliberately removed in 3719117 and is intentionally not being
    // reintroduced here).
    if (expectedHash) {
      const actualHex = verifyHash ? verifyHash.digest('hex') : sha256;
      if (actualHex.toLowerCase() !== expectedHash.hex.toLowerCase()) {
        await fsp.rm(tmpFile, { force: true });
        throw new BadGatewayException(
          `Checksum mismatch for "${meta.name || meta.filename || url}": ` +
            `registry said ${expectedHash.algorithm} ${truncateHash(expectedHash.hex)} ` +
            `but the downloaded file hashed to ${truncateHash(actualHex)}`,
        );
      }
    }

    const [existing] = await this.db
      .select()
      .from(libraryFiles)
      .where(
        and(
          eq(libraryFiles.sha256, sha256),
          eq(libraryFiles.category, category),
        ),
      )
      .limit(1);
    if (existing) {
      await fsp.rm(tmpFile, { force: true });
      return existing;
    }

    const filename = sanitizeFilename(
      meta.filename ||
        decodeURIComponent(path.basename(new URL(url).pathname)) ||
        `file-${sha256.slice(0, 8)}`,
    );
    const relPath = `${CATEGORY_DIR[category]}/${sha256.slice(0, 8)}-${filename}`;
    await fsp.mkdir(path.dirname(this.pathGuard.dataPath(relPath)), {
      recursive: true,
    });
    await fsp.rename(tmpFile, this.pathGuard.dataPath(relPath));
    const size = (await fsp.stat(this.pathGuard.dataPath(relPath))).size;

    const id = `lib_${nanoid(8)}`;
    // onConflictDoNothing closes the check-then-insert race: if a concurrent add for
    // the same (sha256, category) won, our INSERT no-ops (relPath is derived from the
    // sha, so both point at the identical file — nothing to clean up) and we return theirs.
    await this.db
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
      .onConflictDoNothing({
        target: [libraryFiles.sha256, libraryFiles.category],
      });
    const [row] = await this.db
      .select()
      .from(libraryFiles)
      .where(
        and(
          eq(libraryFiles.sha256, sha256),
          eq(libraryFiles.category, category),
        ),
      )
      .limit(1);
    if (row!.id === id) {
      // We won the insert — do the one-time side effects.
      if (meta.iconUrl) this.cacheIcon(id, meta.iconUrl).catch(() => {});
      this.events.recordEvent({
        actor,
        type: 'library-added',
        summary: `Added to library: ${meta.name || filename} (${humanBytes(size)})`,
        details: { id, category, sha256 },
      });
    }
    return row!;
  }

  /** Cache a mod's platform icon locally so the UI never hotlinks. */
  async cacheIcon(libraryId: string, iconUrl: string): Promise<void> {
    try {
      const res = await fetch(iconUrl, {
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return;
      const ext = path.extname(new URL(iconUrl).pathname) || '.png';
      const rel = `library/icons/mods/${libraryId}${ext}`;
      await fsp.mkdir(path.dirname(this.pathGuard.dataPath(rel)), {
        recursive: true,
      });
      await pipeline(
        res.body as unknown as NodeJS.ReadableStream,
        fs.createWriteStream(this.pathGuard.dataPath(rel)),
      );
      await this.db
        .update(libraryFiles)
        .set({ iconRelPath: rel })
        .where(eq(libraryFiles.id, libraryId));
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
    { filename }: { filename?: string } = {},
  ): Promise<{ installedPath: string; filename: string }> {
    const [lib] = await this.db
      .select()
      .from(libraryFiles)
      .where(eq(libraryFiles.id, libraryId))
      .limit(1);
    if (!lib) throw new ConflictException('Library file not found');
    // The panel must own the server dir to write into it — a server created before
    // container-runs-as-panel-user has files owned by uid 1000.
    await this.serverEnv.ensureOwnership(serverId);
    const destDir = this.pathGuard.dataPath('servers', serverId, destRel);
    await fsp.mkdir(destDir, { recursive: true });
    const target = path.join(
      destDir,
      sanitizeFilename(filename || lib.filename),
    );
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
   *
   * `localPath` is read directly with no path-guard validation — it must come
   * from a trusted/internal source (e.g. a multer-generated temp file path),
   * never a raw user-supplied path.
   */
  async importFile(
    localPath: string,
    meta: DownloadMeta,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<LibraryFileRow> {
    const category = meta.category || 'mod';
    const buf = await fsp.readFile(localPath);
    if (buf.length > MAX_DOWNLOAD_BYTES)
      throw new PayloadTooLargeException('File is too large');
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const [existing] = await this.db
      .select()
      .from(libraryFiles)
      .where(
        and(
          eq(libraryFiles.sha256, sha256),
          eq(libraryFiles.category, category),
        ),
      )
      .limit(1);
    if (existing) return existing;
    const filename = sanitizeFilename(
      meta.filename || path.basename(localPath),
    );
    const relPath = `${CATEGORY_DIR[category]}/${sha256.slice(0, 8)}-${filename}`;
    await fsp.mkdir(path.dirname(this.pathGuard.dataPath(relPath)), {
      recursive: true,
    });
    await fsp.writeFile(this.pathGuard.dataPath(relPath), buf);
    const id = `lib_${nanoid(8)}`;
    await this.db
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
      .onConflictDoNothing({
        target: [libraryFiles.sha256, libraryFiles.category],
      });
    const [row] = await this.db
      .select()
      .from(libraryFiles)
      .where(
        and(
          eq(libraryFiles.sha256, sha256),
          eq(libraryFiles.category, category),
        ),
      )
      .limit(1);
    if (row!.id === id) {
      this.events.recordEvent({
        actor,
        type: 'library-added',
        summary: `Uploaded to library: ${meta.name || filename} (${humanBytes(buf.length)})`,
        details: { id, category, sha256 },
      });
    }
    return row!;
  }
}

export function humanBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/** Shorten a hex digest to a reasonable length for an error message. */
export function truncateHash(hex: string): string {
  return hex.length > 16 ? `${hex.slice(0, 16)}…` : hex;
}

export function sanitizeFilename(name: string): string {
  return String(name)
    .replace(/[\\/:*?"<>|\0]/g, '_')
    .slice(0, 180);
}
