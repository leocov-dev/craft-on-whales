import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { contentImportOverrides } from '../db/schema';
import { PathGuardService } from '../storage/path-guard.service';
import { StorageIndexService } from '../storage/storage-index.service';
import { ServerEnvironmentService } from '../servers/server-environment.service';
import { IMPORT_BACKUP_DIR, listFiles } from './pack-archive';
import type { Server } from '../servers/types';
import type {
  ContentImportOverrideWrite,
  ContentImportRemoval,
  ContentImportReport,
} from '../../../shared/types/mods';

type OverrideSkip = ContentImportReport['overrides']['skipped'][number];

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/**
 * Copies a pack's override trees into a server directory and undoes it later.
 *
 * Each file written gets a `content_import_overrides` row recording the
 * sha256 it wrote and whether something was there before. A file that was
 * there is copied to `<server>/.import-backups/<importId>/<path>` first.
 * The row is inserted before the file is written, so a crash mid-apply leaves
 * a row whose hash doesn't match the file, which revert then leaves alone.
 *
 * Revert only touches a file that still hashes to what the import wrote:
 * restore the backup if there was an original, otherwise delete it. Anything
 * edited or removed since is left as it is. See MODS_NOTES.md.
 */
@Injectable()
export class PackOverridesService {
  private readonly logger = new Logger(PackOverridesService.name);

  constructor(
    private readonly dbService: DbService,
    private readonly pathGuard: PathGuardService,
    private readonly indexer: StorageIndexService,
    private readonly serverEnv: ServerEnvironmentService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  /**
   * Relative paths the override trees would write, later roots winning,
   * minus paths `exclude` claims (jars installed as content instead).
   */
  async plan(
    stagingDir: string,
    roots: readonly string[],
    exclude: (stagedPath: string) => boolean,
  ): Promise<{ files: Map<string, string>; skipped: OverrideSkip[] }> {
    const files = new Map<string, string>();
    const reserved = new Set<string>();
    for (const root of roots) {
      const rootAbs = path.join(stagingDir, root);
      for (const rel of await listFiles(rootAbs)) {
        if (exclude(`${root}/${rel}`)) continue;
        if (rel.split('/')[0] === IMPORT_BACKUP_DIR) reserved.add(rel);
        else files.set(rel, path.join(rootAbs, rel));
      }
    }
    return {
      files,
      skipped: [...reserved].map((p) => ({ path: p, reason: 'reserved' })),
    };
  }

  /**
   * Write planned override files into the server directory, tracked under
   * `importId`. On any failure the files already written are reverted and
   * the error rethrown.
   */
  async apply(
    server: Server,
    importId: string,
    files: Map<string, string>,
  ): Promise<{
    written: ContentImportOverrideWrite[];
    skipped: OverrideSkip[];
  }> {
    const written: ContentImportOverrideWrite[] = [];
    const skipped: OverrideSkip[] = [];
    if (!files.size) return { written, skipped };

    let bytes = 0;
    for (const src of files.values()) bytes += (await fsp.stat(src)).size;
    await this.indexer.assertUnderQuota(server, bytes);
    await this.serverEnv.ensureOwnership(server.id);

    const serverDir = this.pathGuard.dataPath('servers', server.id);
    const backupRoot = this.pathGuard.safeJoin(
      serverDir,
      IMPORT_BACKUP_DIR,
      importId,
    );
    try {
      for (const [rel, src] of files) {
        // The security boundary: every write target resolves through safeJoin,
        // which also refuses a path that escapes through a symlinked directory.
        const target = this.pathGuard.safeJoin(serverDir, rel);
        const existing = await fsp.lstat(target).catch(() => null);
        if (existing && !existing.isFile()) {
          skipped.push({ path: rel, reason: 'not-a-file' });
          continue;
        }
        if (existing) {
          const backup = this.pathGuard.safeJoin(backupRoot, rel);
          await fsp.mkdir(path.dirname(backup), { recursive: true });
          await fsp.copyFile(target, backup);
        }
        await this.db.insert(contentImportOverrides).values({
          id: `cio_${nanoid(10)}`,
          importId,
          relPath: rel,
          sha256: await sha256File(src),
          hadOriginal: Boolean(existing),
        });
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.copyFile(src, target);
        written.push({ path: rel, action: existing ? 'replaced' : 'created' });
      }
    } catch (err) {
      await this.revert(server.id, importId).catch((e: unknown) =>
        this.logger.error(
          `Reverting a failed overrides apply for ${importId} failed too: ${String(e)}`,
        ),
      );
      throw err;
    }
    return { written, skipped };
  }

  /** Undo an import's override writes and drop their tracking rows and backups. */
  async revert(
    serverId: string,
    importId: string,
  ): Promise<ContentImportRemoval['overrides']> {
    const result: ContentImportRemoval['overrides'] = {
      restored: [],
      deleted: [],
      kept: [],
    };
    const rows = await this.db
      .select()
      .from(contentImportOverrides)
      .where(eq(contentImportOverrides.importId, importId));
    const serverDir = this.pathGuard.dataPath('servers', serverId);
    const backupRoot = this.pathGuard.safeJoin(
      serverDir,
      IMPORT_BACKUP_DIR,
      importId,
    );

    for (const row of rows) {
      let target: string;
      try {
        target = this.pathGuard.safeJoin(serverDir, row.relPath);
      } catch {
        // A symlink now routes this path outside the server: don't follow it.
        result.kept.push(row.relPath);
        continue;
      }
      const st = await fsp.lstat(target).catch(() => null);
      const current = st?.isFile() ? await sha256File(target) : null;
      if (current !== row.sha256) {
        result.kept.push(row.relPath);
        continue;
      }
      if (row.hadOriginal) {
        const backup = this.pathGuard.safeJoin(backupRoot, row.relPath);
        const hasBackup = (await fsp.lstat(backup).catch(() => null))?.isFile();
        if (!hasBackup) {
          result.kept.push(row.relPath);
          continue;
        }
        await fsp.copyFile(backup, target);
        result.restored.push(row.relPath);
      } else {
        await fsp.rm(target, { force: true });
        await this.pruneEmptyDirs(path.dirname(target), serverDir);
        result.deleted.push(row.relPath);
      }
    }

    await fsp.rm(backupRoot, { recursive: true, force: true });
    await this.pruneEmptyDirs(path.dirname(backupRoot), serverDir);
    await this.db
      .delete(contentImportOverrides)
      .where(eq(contentImportOverrides.importId, importId));
    return result;
  }

  /** Remove now-empty directories from `dir` up to (not including) `stop`. */
  private async pruneEmptyDirs(dir: string, stop: string): Promise<void> {
    let current = dir;
    while (current.startsWith(stop + path.sep)) {
      try {
        await fsp.rmdir(current);
      } catch {
        return; // not empty (or already gone): stop climbing
      }
      current = path.dirname(current);
    }
  }
}
