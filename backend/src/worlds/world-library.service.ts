import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { DbService } from '../db/db.service';
import { PathGuardService } from '../storage/path-guard.service';
import { StorageIndexService } from '../storage/storage-index.service';
import { EventsService } from '../events/events.service';
import { LibraryService, CATEGORY_DIR } from '../library/library.service';
import { libraryFiles, servers } from '../db/schema';
import { WorldArchiveService } from './world-archive.service';
import type { LibraryWorld } from '../../../shared/types/worlds';

export type { LibraryWorld };

export interface ImportArchiveOptions {
  name?: string;
  originalName?: string;
  actor?: string;
  flavor?: string | null;
  source?: string;
  onProgress?: (info: { stage: string }) => void;
}

export type LibraryWorldView = LibraryWorld;

/**
 * World-library CRUD — the library_files rows for category='world' plus
 * import-archive/add-to-library plumbing. Ports the "Import (upload) into
 * the library" + "Library listing / delete" sections of
 * `src/services/worlds.ts`. Uses `LibraryService.deleteLibraryFile` for
 * actual deletion (shared with mod/modpack library entries).
 */
@Injectable()
export class WorldLibraryService {
  constructor(
    private readonly dbService: DbService,
    private readonly pathGuard: PathGuardService,
    private readonly indexer: StorageIndexService,
    private readonly events: EventsService,
    private readonly library: LibraryService,
    private readonly archive: WorldArchiveService
  ) {}

  private get db() {
    return this.dbService.db;
  }

  /**
   * Import an uploaded world archive (.zip / .mcworld / .tar / .tar.gz) into
   * the library: extract to tmp, detect the world root, normalize into a
   * fresh zip under library/worlds, hash, and record a library_files row.
   */
  async importArchive(
    uploadPath: string,
    { name = '', originalName = '', actor = 'system', flavor = null, source = 'upload', onProgress = () => {} }: ImportArchiveOptions = {}
  ) {
    const stat = await fsp.stat(uploadPath).catch(() => null);
    if (!stat || !stat.isFile()) throw new BadRequestException('Upload not found — try again');

    // Free-space preflight: extraction + re-zip can need ~3x the archive size.
    const { free } = await this.indexer.diskFree();
    if (free < stat.size * 3) {
      throw new HttpException(`Not enough disk space to import this world (~${this.archive.humanBytes(stat.size * 3)} needed)`, 507);
    }

    const tmpDir = this.pathGuard.dataPath('tmp', `world-import-${nanoid(6)}`);
    const zipTmp = this.pathGuard.dataPath('tmp', `world-norm-${nanoid(6)}.zip`);
    await fsp.mkdir(tmpDir, { recursive: true });

    try {
      onProgress({ stage: 'extract' });
      await this.archive.extractArchive(uploadPath, tmpDir, originalName);

      const detected = await this.archive.detectWorldRoot(tmpDir);
      if (!detected) throw new BadRequestException("No level.dat found — this doesn't look like a Minecraft world");

      const mcVersion = this.archive.readLevelVersion(path.join(detected.rootAbs, 'level.dat'));

      onProgress({ stage: 'pack' });
      await this.archive.zipWorld(zipTmp, detected.rootAbs, detected.dims.slice(1));

      const worldName =
        (name || '').trim() ||
        path.basename(originalName || '', path.extname(originalName || '')) ||
        path.basename(detected.rootAbs) ||
        'Imported world';

      return await this.addZipToLibrary(zipTmp, {
        name: worldName,
        actor,
        worldSource: source,
        worldFlavor: flavor,
        mcVersion,
        split: detected.split,
      });
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(zipTmp, { force: true }).catch(() => {});
      await fsp.rm(uploadPath, { force: true }).catch(() => {});
    }
  }

  /** Move a finished world zip into library/worlds + insert the DB row (dedup by hash). */
  async addZipToLibrary(
    zipAbs: string,
    {
      name,
      actor,
      worldSource,
      worldFlavor,
      mcVersion,
      split,
    }: { name: string; actor: string; worldSource?: string; worldFlavor?: string | null; mcVersion: string | null; split: boolean }
  ) {
    const sha256 = await this.archive.sha256File(zipAbs);
    const [existing] = await this.db
      .select()
      .from(libraryFiles)
      .where(and(eq(libraryFiles.sha256, sha256), eq(libraryFiles.category, 'world')))
      .limit(1);
    if (existing) {
      await fsp.rm(zipAbs, { force: true });
      return existing;
    }

    const filename = `${this.archive.sanitizeFilename(name)}.zip`;
    const relPath = `${CATEGORY_DIR.world}/${sha256.slice(0, 8)}-${filename}`;
    await fsp.mkdir(path.dirname(this.pathGuard.dataPath(relPath)), { recursive: true });
    await this.archive.moveFile(zipAbs, this.pathGuard.dataPath(relPath));
    const size = (await fsp.stat(this.pathGuard.dataPath(relPath))).size;

    const id = `lib_${nanoid(8)}`;
    await this.db.insert(libraryFiles).values({
      id,
      category: 'world',
      name,
      filename,
      relPath,
      sha256,
      sizeBytes: size,
      platform: 'upload',
      version: mcVersion || null,
      mcVersionsJson: JSON.stringify(mcVersion ? [mcVersion] : []),
      loadersJson: '[]',
      worldSource: worldSource || 'upload',
      worldFlavor: worldFlavor || null,
    });
    this.events.recordEvent({
      actor,
      type: 'world-library-added',
      summary: `World added to library: ${name} (${this.archive.humanBytes(size)})`,
      details: { id, sha256, sizeBytes: size, split: Boolean(split), mcVersion: mcVersion || null, source: worldSource },
    });
    this.indexer.scan().catch(() => {});
    const [row] = await this.db.select().from(libraryFiles).where(eq(libraryFiles.id, id)).limit(1);
    return row!;
  }

  async mustLibWorld(libraryId: string) {
    const [lib] = await this.db
      .select()
      .from(libraryFiles)
      .where(and(eq(libraryFiles.id, libraryId), eq(libraryFiles.category, 'world')))
      .limit(1);
    if (!lib) throw new NotFoundException('World not found in the library');
    return lib;
  }

  /** All library worlds mapped for the UI (friendly source labels, compat info). */
  async libraryWorlds(): Promise<LibraryWorldView[]> {
    const rows = await this.db.select().from(libraryFiles).where(eq(libraryFiles.category, 'world')).orderBy(desc(libraryFiles.createdAt));
    const results: LibraryWorldView[] = [];
    for (const row of rows) {
      let source = 'Imported';
      let sourceKind: 'import' | 'upload' | 'extract' = 'import';
      if (row.worldSource === 'upload') {
        source = 'Uploaded';
        sourceKind = 'upload';
      } else if (row.worldSource && row.worldSource.startsWith('extract:')) {
        const sid = row.worldSource.slice('extract:'.length);
        const [server] = await this.db.select({ displayName: servers.displayName }).from(servers).where(eq(servers.id, sid)).limit(1);
        source = `Extracted from ${server ? server.displayName : sid}`;
        sourceKind = 'extract';
      }
      results.push({
        id: row.id,
        name: row.name,
        filename: row.filename,
        source,
        sourceKind,
        flavor: row.worldFlavor,
        mcVersion: row.version,
        size: row.sizeBytes,
        created: (row.createdAt || '').slice(0, 16),
        createdMs: (() => {
          const ms = Date.parse((row.createdAt || '').replace(' ', 'T') + 'Z');
          return Number.isFinite(ms) ? ms : null;
        })(),
        hash: row.sha256.slice(0, 10),
      });
    }
    return results;
  }

  /** Delete a library world archive (delegates to the shared library service). */
  async deleteLibraryWorld(id: string, { actor = 'system' }: { actor?: string } = {}) {
    await this.mustLibWorld(id);
    return this.library.deleteLibraryFile(id, { actor });
  }
}
