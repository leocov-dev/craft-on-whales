import { ConflictException, Injectable } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { and, desc, eq, gt, isNull, notInArray, sql } from 'drizzle-orm';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { EventsService } from '../events/events.service';
import { ServerLifecycleService } from '../servers/server-lifecycle.service';
import { storageIndex, storageSnapshots, servers } from '../db/schema';

interface ScanResult {
  size: number;
  files: number;
}

export interface ScanSummary {
  totalBytes: number;
  dirs: number;
  ms: number;
}

export interface ScanSkipped {
  skipped: true;
}

export interface DiskFree {
  free: number;
  total: number;
}

export interface QuotaServer {
  id: string;
  display_name: string;
  disk_quota_bytes?: number | null;
}

/**
 * Size indexer: walks DATA_DIR in the background, caches per-directory sizes
 * in SQLite so every size shown in the UI is an instant lookup, and records
 * growth snapshots. Never blocks a request on a disk walk.
 *
 * Scoped port of `src/storage/indexer.ts` — covers everything `WorldsModule`
 * / `BackupsService` need (`scan`, `sizeOf`, `diskFree`, `assertUnderQuota`,
 * `enforceStrictQuotas`). `startIndexer`'s periodic-scan scheduling and the
 * broader `StorageModule` (quota UI endpoints, `dataRoot` cleanup) are still
 * the plan's later `StorageModule` step — extend this service then rather
 * than re-porting indexer.ts from scratch.
 */
@Injectable()
export class StorageIndexService {
  private scanning = false;

  constructor(
    private readonly config: ConfigService,
    private readonly dbService: DbService,
    private readonly events: EventsService,
    private readonly lifecycle: ServerLifecycleService
  ) {}

  private get db() {
    return this.dbService.db;
  }

  async scan(): Promise<ScanSummary | ScanSkipped> {
    if (this.scanning) return { skipped: true };
    this.scanning = true;
    const started = Date.now();
    try {
      const root = this.config.dataDir;
      const results = new Map<string, ScanResult>();

      const walk = async (abs: string, rel: string): Promise<ScanResult> => {
        let size = 0;
        let files = 0;
        let entries;
        try {
          entries = await fs.readdir(abs, { withFileTypes: true });
        } catch {
          return { size: 0, files: 0 };
        }
        for (const entry of entries) {
          const childAbs = path.join(abs, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            const sub = await walk(childAbs, rel ? `${rel}/${entry.name}` : entry.name);
            size += sub.size;
            files += sub.files;
          } else if (entry.isFile()) {
            try {
              const st = await fs.stat(childAbs);
              size += st.size;
              files += 1;
            } catch {
              /* transient */
            }
          }
        }
        if (rel) results.set(rel, { size, files });
        return { size, files };
      };

      const total = await walk(root, '');
      results.set('', total);

      this.db.transaction((tx) => {
        tx.delete(storageIndex).run();
        for (const [rel, v] of results) {
          // Cache depth <= 3 to keep the table small; deeper paths are summed live.
          if (rel.split('/').length <= 3) {
            tx.insert(storageIndex).values({ relPath: rel, sizeBytes: v.size, fileCount: v.files }).run();
          }
        }
      });

      const perServer: Record<string, number> = {};
      for (const [rel, v] of results) {
        const m = /^servers\/([^/]+)$/.exec(rel);
        if (m) perServer[m[1] as string] = v.size;
      }
      this.db.insert(storageSnapshots).values({ totalBytes: total.size, perServerJson: JSON.stringify(perServer) }).run();
      // Retention: keep the last 500 snapshots.
      const keepIds = this.db
        .select({ id: storageSnapshots.id })
        .from(storageSnapshots)
        .orderBy(desc(storageSnapshots.id))
        .limit(500)
        .all()
        .map((r) => r.id);
      if (keepIds.length) {
        this.db.delete(storageSnapshots).where(notInArray(storageSnapshots.id, keepIds)).run();
      }

      return { totalBytes: total.size, dirs: results.size, ms: Date.now() - started };
    } finally {
      this.scanning = false;
    }
  }

  /** Instant size lookup from cache; 0 when not yet scanned. */
  sizeOf(relPath: string): number {
    const row = this.db.select({ sizeBytes: storageIndex.sizeBytes }).from(storageIndex).where(eq(storageIndex.relPath, relPath)).get();
    return row ? Number(row.sizeBytes) : 0;
  }

  lastScan(): string | null {
    const row = this.db.select({ t: sql<string | null>`max(${storageIndex.scannedAt})` }).from(storageIndex).get();
    return row && row.t != null ? String(row.t) : null;
  }

  async diskFree(): Promise<DiskFree> {
    const st = await fs.statfs(this.config.dataDir);
    return { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
  }

  /** Quota check used before disk-growing operations. Throws a friendly 409. */
  assertUnderQuota(server: QuotaServer, aboutToAddBytes = 0): void {
    if (!server.disk_quota_bytes) return;
    const used = this.sizeOf(`servers/${server.id}`);
    if (used + aboutToAddBytes > server.disk_quota_bytes) {
      throw new ConflictException(`${server.display_name} is over its disk quota — free space or raise the limit in Settings → Resources`);
    }
  }

  /**
   * Strict-mode sweep: auto-stop servers >10% over quota. Called after scans.
   * Legacy lazily requires `./servers` here to avoid a require cycle that
   * doesn't actually exist in this direction (servers.ts never requires
   * indexer.ts back) — this port injects `ServerLifecycleService` directly.
   */
  async enforceStrictQuotas(): Promise<void> {
    const rows = this.db
      .select()
      .from(servers)
      .where(and(isNull(servers.deletedAt), eq(servers.quotaStrict, true), gt(servers.diskQuotaBytes, 0)))
      .all();
    for (const s of rows) {
      const used = this.sizeOf(`servers/${s.id}`);
      if (used > s.diskQuotaBytes * 1.1 && ['running', 'starting', 'unhealthy'].includes(s.status)) {
        this.events.recordEvent({
          serverId: s.id,
          type: 'quota-exceeded',
          summary: `Strict quota: usage ${(used / 1024 ** 3).toFixed(1)} GB exceeds quota by >10% — stopping server`,
        });
        await this.lifecycle.stopServer(s.id, { actor: 'system' }).catch(() => {});
      }
    }
  }
}
