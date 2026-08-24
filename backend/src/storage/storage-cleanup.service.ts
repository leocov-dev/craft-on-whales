import { BadRequestException, Injectable } from '@nestjs/common';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { lt, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { EventsService } from '../events/events.service';
import { PathGuardService } from './path-guard.service';
import { StorageIndexService } from './storage-index.service';
import { LibraryService } from '../library/library.service';
import { CrashesService } from '../crashes/crashes.service';
import { crashReports } from '../db/schema';
import type { CleanupAction } from '../../../shared/types/storage';

export type { CleanupAction };

const TMP_MIN_AGE_MS = 60 * 60 * 1000; // never touch in-flight transfers

export const DEFAULT_DAYS = 30;

export interface RunCleanupOptions {
  olderThanDays?: number;
  dryRun?: boolean;
  actor?: string;
}

export interface CleanupResult {
  freedBytes: number;
  removed: number;
}

export interface LargestFilesOptions {
  top?: number;
  maxScan?: number;
}

export interface LargestFileEntry {
  path: string;
  size: number;
}

/**
 * Storage maintenance: tmp/orphan-library/old-log/old-crash cleanup +
 * largest-files scan. Ports `src/web/routes/storageCleanup.ts` (was
 * route-layer-only in legacy; promoted to a real service here since Nest
 * controllers stay thin).
 */
@Injectable()
export class StorageCleanupService {
  constructor(
    private readonly dbService: DbService,
    private readonly events: EventsService,
    private readonly pathGuard: PathGuardService,
    private readonly indexer: StorageIndexService,
    private readonly library: LibraryService,
    private readonly crashes: CrashesService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  private async entrySize(abs: string): Promise<number> {
    const st = await fsp.lstat(abs).catch(() => null);
    if (!st || st.isSymbolicLink()) return 0;
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return 0;
    let total = 0;
    const entries = await fsp
      .readdir(abs, { withFileTypes: true })
      .catch(() => []);
    for (const e of entries)
      total += await this.entrySize(path.join(abs, e.name));
    return total;
  }

  async runCleanup(
    action: CleanupAction,
    { olderThanDays, dryRun = false, actor = 'system' }: RunCleanupOptions = {},
  ): Promise<CleanupResult> {
    const days = olderThanDays || DEFAULT_DAYS;
    let freedBytes = 0;
    let removed = 0;

    if (action === 'tmp') {
      const dir = this.pathGuard.dataPath('tmp');
      const entries = await fsp.readdir(dir).catch(() => []);
      for (const name of entries) {
        const abs = path.join(dir, name);
        const st = await fsp.lstat(abs).catch(() => null);
        if (!st || Date.now() - st.mtimeMs < TMP_MIN_AGE_MS) continue;
        freedBytes += st.isDirectory() ? await this.entrySize(abs) : st.size;
        removed += 1;
        if (!dryRun)
          await fsp.rm(abs, { recursive: true, force: true }).catch(() => {});
      }
    } else if (action === 'orphans') {
      for (const row of await this.library.orphans()) {
        freedBytes += row.sizeBytes || 0;
        removed += 1;
        if (!dryRun)
          await this.library
            .deleteLibraryFile(row.id, { actor, force: true })
            .catch(() => {});
      }
    } else if (action === 'old-logs') {
      const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
      const logsRoot = this.pathGuard.dataPath('logs');
      const owners = await fsp
        .readdir(logsRoot, { withFileTypes: true })
        .catch(() => []);
      for (const owner of owners) {
        if (!owner.isDirectory()) continue;
        const candidates = [
          path.join(logsRoot, owner.name),
          path.join(logsRoot, owner.name, 'events'),
        ];
        for (const dir of candidates) {
          const files = await fsp
            .readdir(dir, { withFileTypes: true })
            .catch(() => []);
          for (const f of files) {
            if (!f.isFile()) continue;
            const abs = path.join(dir, f.name);
            const st = await fsp.stat(abs).catch(() => null);
            if (!st || st.mtimeMs >= cutoffMs) continue;
            freedBytes += st.size;
            removed += 1;
            if (!dryRun) await fsp.rm(abs, { force: true }).catch(() => {});
          }
        }
      }
    } else if (action === 'old-crashes') {
      const cutoffIso = new Date(
        Date.now() - days * 24 * 60 * 60 * 1000,
      ).toISOString();
      if (dryRun) {
        const [row] = await this.db
          .select({
            n: sql<number>`count(*)`,
            s: sql<number>`coalesce(sum(size_bytes), 0)`,
          })
          .from(crashReports)
          .where(lt(crashReports.fileMtime, cutoffIso))
          .limit(1);
        removed = Number(row?.n) || 0;
        freedBytes = Number(row?.s) || 0;
      } else {
        const owners = await this.db
          .selectDistinct({ serverId: crashReports.serverId })
          .from(crashReports)
          .where(lt(crashReports.fileMtime, cutoffIso));
        for (const { serverId } of owners) {
          const result = await this.crashes.deleteOlderThan(serverId, days, {
            actor,
          });
          removed += result.deleted;
          freedBytes += result.freedBytes;
        }
      }
    } else {
      throw new BadRequestException(`Unknown cleanup action "${action}"`);
    }

    if (!dryRun && removed > 0) {
      this.events.recordEvent({
        actor,
        type: 'storage-cleanup',
        summary: `Storage cleanup (${action}): ${removed} item(s) removed, ${(freedBytes / 1024 ** 2).toFixed(1)} MB freed`,
        details: { action, removed, freedBytes, olderThanDays: days },
      });
      this.indexer.scan().catch(() => {});
    }
    return { freedBytes, removed };
  }

  /** Breadth-first walk of ./data collecting the largest files. Bounded by a
   *  file-scan cap so a huge tree can never stall a page render. */
  async largestFiles({
    top = 15,
    maxScan = 3000,
  }: LargestFilesOptions = {}): Promise<LargestFileEntry[]> {
    const best: LargestFileEntry[] = [];
    const queue: string[] = [''];
    let scanned = 0;
    while (queue.length && scanned < maxScan) {
      const rel = queue.shift() as string;
      const entries = await fsp
        .readdir(this.pathGuard.dataPath(rel || '.'), { withFileTypes: true })
        .catch(() => []);
      for (const e of entries) {
        if (e.isSymbolicLink()) continue;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          queue.push(childRel);
        } else if (e.isFile()) {
          scanned += 1;
          const st = await fsp
            .stat(this.pathGuard.dataPath(childRel))
            .catch(() => null);
          if (!st) continue;
          best.push({ path: childRel, size: st.size });
          if (best.length > top * 3) {
            best.sort((a, b) => b.size - a.size);
            best.length = top;
          }
          if (scanned >= maxScan) break;
        }
      }
    }
    best.sort((a, b) => b.size - a.size);
    return best.slice(0, top);
  }
}
