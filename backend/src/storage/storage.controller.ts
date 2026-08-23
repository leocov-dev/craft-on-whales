import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { desc } from 'drizzle-orm';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { DbService } from '../db/db.service';
import { StorageIndexService } from './storage-index.service';
import { StorageCleanupService, DEFAULT_DAYS, type CleanupAction } from './storage-cleanup.service';
import { storageSnapshots } from '../db/schema';
import type { StorageData } from '../../../shared/types/storage';

const cleanupSchema = z.object({
  action: z.enum(['tmp', 'orphans', 'old-logs', 'old-crashes']),
  olderThanDays: z.coerce.number().int().min(1).max(3650).optional(),
  dryRun: z.coerce.boolean().optional(),
});

const CATEGORY_NAMES: Record<string, string> = {
  servers: 'Servers',
  backups: 'Backups',
  'library/worlds': 'Library — worlds',
  'library/mods': 'Library — mods & content',
  'library/modpacks': 'Library — modpacks',
  'library/icons': 'Library — icons',
  logs: 'Logs & event captures',
  blueprints: 'Blueprints',
  tmp: 'tmp',
};

/** Ports the `/storage*` cluster of `src/web/routes/api.ts`. */
@Controller('api/storage')
export class StorageController {
  constructor(
    private readonly dbService: DbService,
    private readonly indexer: StorageIndexService,
    private readonly cleanup: StorageCleanupService
  ) {}

  private get db() {
    return this.dbService.db;
  }

  @Post('scan')
  async scan() {
    return { ok: true, ...(await this.indexer.scan()) };
  }

  @Post('cleanup')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async runCleanup(@Body() body: unknown) {
    const { action, olderThanDays, dryRun } = cleanupSchema.parse(body);
    const result = await this.cleanup.runCleanup(action as CleanupAction, {
      olderThanDays,
      dryRun: Boolean(dryRun),
      actor: 'system',
    });
    return { ok: true, dryRun: Boolean(dryRun), ...result };
  }

  @Get()
  @UseGuards(RolesGuard)
  @Roles('admin')
  async breakdown() {
    const { free, total } = await this.indexer.diskFree().catch(() => ({ free: 0, total: 0 }));
    const categories = (
      await Promise.all(
        Object.entries(CATEGORY_NAMES).map(async ([rel, name]) => ({
          name,
          path: `${rel}/`,
          link: `/files?path=${encodeURIComponent(rel)}`,
          size: await this.indexer.sizeOf(rel),
        }))
      )
    ).filter((c) => c.size > 0 || ['servers', 'backups', 'tmp'].includes(c.path.replace(/\/$/, '')));

    const snapshotRows = await this.db
      .select({ totalBytes: storageSnapshots.totalBytes })
      .from(storageSnapshots)
      .orderBy(desc(storageSnapshots.id))
      .limit(14);
    const snapshots = snapshotRows.reverse();
    const maxSnap = Math.max(1, ...snapshots.map((s) => Number(s.totalBytes) || 0));

    const totalUsed = await this.indexer.sizeOf('');
    const segs = [
      { label: 'Servers', color: 'positive', size: await this.indexer.sizeOf('servers') },
      { label: 'Backups', color: 'info', size: await this.indexer.sizeOf('backups') },
      { label: 'Library', color: 'warning', size: await this.indexer.sizeOf('library') },
    ];
    segs.push({
      label: 'Logs, blueprints, tmp',
      color: 'grey',
      size: Math.max(0, totalUsed - segs.reduce((n, s) => n + s.size, 0)),
    });
    const breakdown = segs.map((s) => ({
      ...s,
      width: totalUsed ? Math.max(0.5, (s.size / totalUsed) * 100) : 0,
    }));

    const preview = async (action: CleanupAction, label: string, olderThanDays?: number) => {
      const p = await this.cleanup.runCleanup(action, { olderThanDays, dryRun: true }).catch(() => ({ freedBytes: 0, removed: 0 }));
      return { key: action, action: label, frees: p.freedBytes, count: p.removed, days: olderThanDays || null };
    };
    const cleanupPreview = await Promise.all([
      preview('tmp', 'Purge tmp/ (files older than 1 h)'),
      preview('orphans', 'Remove orphaned library files'),
      preview('old-logs', `Delete archived logs older than ${DEFAULT_DAYS} days`, DEFAULT_DAYS),
      preview('old-crashes', `Delete crash reports older than ${DEFAULT_DAYS} days`, DEFAULT_DAYS),
    ]);

    const largest = (await this.cleanup.largestFiles({ top: 15, maxScan: 3000 }).catch(() => [])).map((f) => ({
      ...f,
      link: `/files?path=${encodeURIComponent(f.path.split('/').slice(0, -1).join('/'))}`,
    }));

    const storage: StorageData = {
      totalUsed,
      diskFree: free,
      diskTotal: total,
      lastScan: (await this.indexer.lastScan()) || null,
      categories,
      breakdown,
      largestFiles: largest,
      cleanup: cleanupPreview,
      trend: snapshots.map((s) => Math.max(4, Math.round(((Number(s.totalBytes) || 0) / maxSnap) * 100))),
    };
    return { ok: true, storage };
  }
}
