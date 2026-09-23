import {
  BadRequestException,
  HttpException,
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ZipArchive } from 'archiver';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { DbService } from '../db/db.service';
import { ContainerService } from '../docker/container.service';
import { rcon } from '../utils/rcon';
import { ServerLifecycleService } from '../servers/server-lifecycle.service';
import { PathGuardService } from '../storage/path-guard.service';
import { StorageIndexService } from '../storage/storage-index.service';
import { EventsService } from '../events/events.service';
import { SettingsService } from '../settings/settings.service';
import { backups, servers } from '../db/schema';
import { WorldArchiveService } from './world-archive.service';
import { WorldSaveLockService } from './world-save-lock.service';

// Retention ceilings, per server, per reason. Every bucket is bounded and
// pruned INDEPENDENTLY: the old rule ("keep the newest 10 scheduled; manual
// and pre-update are never auto-pruned") let a long-lived server accumulate
// backups until the free-space preflight started failing every new one, and
// tagging restore/world-reset safety snapshots 'manual' meant an automatic
// snapshot could evict a backup the user deliberately kept. 'pre-restore' is
// that safety-snapshot bucket — small, and it can only ever evict its own.
export const RETENTION_BUCKETS: ReadonlyArray<readonly [string, number]> = [
  ['scheduled', 10],
  ['pre-update', 10],
  ['manual', 20],
  ['pre-restore', 5],
];

/** Reason tagged on the safety snapshot taken before a destructive world op. */
export const PRE_RESTORE_REASON = 'pre-restore';

export interface CreateBackupOptions {
  reason?: string;
  actor?: string;
  note?: string;
  task?: {
    step(label: string): void;
    progress(current: number, total?: number): void;
  } | null;
}

export interface RestoreBackupOptions {
  actor?: string;
  skipSafety?: boolean;
  task?: { step(label: string): void } | null;
}

/**
 * Backups: consistent snapshots of a server dir into DATA_DIR/backups/<id>/,
 * with the save-off/save-all/save-on dance when the server is running,
 * retention pruning, and restore. Ports `src/services/backups.ts`.
 */
@Injectable()
export class BackupsService {
  constructor(
    private readonly dbService: DbService,
    private readonly containers: ContainerService,
    private readonly lifecycle: ServerLifecycleService,
    private readonly pathGuard: PathGuardService,
    private readonly indexer: StorageIndexService,
    private readonly events: EventsService,
    private readonly archive: WorldArchiveService,
    private readonly saveLock: WorldSaveLockService,
    private readonly settings: SettingsService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  async createBackup(
    serverId: string,
    {
      reason = 'manual',
      actor = 'system',
      note = '',
      task = null,
    }: CreateBackupOptions = {},
  ) {
    const [server] = await this.db
      .select()
      .from(servers)
      .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)))
      .limit(1);
    if (!server) throw new NotFoundException('Server not found');

    const needed = (await this.indexer.sizeOf(`servers/${serverId}`)) || 0;
    const { free } = await this.indexer.diskFree();
    if (needed && free < needed * 1.1) {
      throw new HttpException(
        `Not enough disk space for a backup (~${(needed / 1024 ** 3).toFixed(1)} GB needed)`,
        507,
      );
    }

    const info = await this.containers
      .inspectStatus(serverId)
      .catch(() => ({ exists: false, status: 'stopped' as const }));
    const running =
      info.exists && ['running', 'starting', 'unhealthy'].includes(info.status);

    // Seconds-resolution stamp + a nanoid suffix: two backups in the same
    // minute (or even second) can never collide on filename/rel_path.
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const filename = `${serverId}-${reason}-${stamp}-${nanoid(4)}.zip`;
    const relPath = `backups/${serverId}/${filename}`;
    const absPath = this.pathGuard.dataPath(relPath);
    await fsp.mkdir(path.dirname(absPath), { recursive: true });

    const doArchive = async () => {
      if (task) task.step('Compressing server files');
      await this.zipDirectory(
        this.pathGuard.dataPath('servers', serverId),
        absPath,
        {
          onProgress: task
            ? (processedBytes: number) => task.progress(processedBytes, needed)
            : null,
        },
      );
    };

    let inconsistent = false;
    if (running) {
      // Serialize the pause-saves/copy/resume-saves section per server so a
      // concurrent backup or world export can't re-enable writes mid-copy.
      await this.saveLock.withSaveLock(serverId, async () => {
        if (task) task.step('Pausing world saves');
        const paused = await rcon(this.containers, serverId, ['save-off'], {
          clean: 'raw',
        })
          .then(() => true)
          .catch((err: Error) => {
            console.warn(
              `[backup] save-off failed for ${serverId}: ${err.message} — archive may be slightly inconsistent`,
            );
            return false;
          });
        inconsistent = !paused;
        await rcon(this.containers, serverId, ['save-all', 'flush'], {
          clean: 'raw',
        }).catch(() => {});
        await this.archive.sleep(2000);
        try {
          await doArchive();
        } finally {
          await rcon(this.containers, serverId, ['save-on'], {
            clean: 'raw',
          }).catch(() => {});
        }
      });
    } else {
      await doArchive();
    }

    const size = (await fsp.stat(absPath)).size;

    // Post-write integrity check. A torn archive (the disk filling mid-write
    // despite the preflight, an archiver fault, a filesystem hiccup) has to
    // be caught HERE — not months later, when a restore is the only thing
    // between the operator and data loss. Reading the central directory is
    // cheap (no decompression) and proves the zip is structurally sound.
    let entryCount: number;
    try {
      entryCount = await this.archive.zipEntryCount(absPath);
    } catch (err) {
      await fsp.rm(absPath, { force: true }).catch(() => {});
      throw new HttpException(
        `Backup archive failed its integrity check and was discarded: ${(err as Error).message}`,
        500,
      );
    }
    // A zero-entry archive is structurally fine (e.g. a server that has never
    // started has nothing on disk yet) — record it, but flag it loudly.
    const empty = entryCount === 0;

    const id = `bk_${nanoid(8)}`;
    await this.db.insert(backups).values({
      id,
      serverId,
      filename,
      relPath,
      sizeBytes: size,
      reason,
      note,
    });
    const warnings = [
      inconsistent
        ? 'world saves could not be paused, archive may be slightly inconsistent'
        : null,
      empty
        ? 'archive contains no files — the server has nothing on disk yet'
        : null,
    ].filter((w): w is string => w !== null);
    this.events.recordEvent({
      serverId,
      actor,
      type: 'backup-created',
      summary:
        `Backup created (${reason}, ${(size / 1024 ** 3).toFixed(2)} GB)` +
        (warnings.length ? ` — WARNING: ${warnings.join('; ')}` : ''),
      details: { id, filename, reason, inconsistent, empty, entryCount },
    });
    await this.pruneRetention(serverId, { actor });
    this.indexer.scan().catch(() => {});
    const [row] = await this.db
      .select()
      .from(backups)
      .where(eq(backups.id, id))
      .limit(1);
    return row!;
  }

  /** Restore = stop server, wipe dir, extract archive. Safety backup first unless told not to. */
  async restoreBackup(
    serverId: string,
    backupId: string,
    {
      actor = 'system',
      skipSafety = false,
      task = null,
    }: RestoreBackupOptions = {},
  ): Promise<{ ok: true }> {
    const [backup] = await this.db
      .select()
      .from(backups)
      .where(and(eq(backups.id, backupId), eq(backups.serverId, serverId)))
      .limit(1);
    if (!backup) throw new NotFoundException('Backup not found');

    const zipStat = await fsp
      .stat(this.pathGuard.dataPath(backup.relPath))
      .catch(() => null);
    if (!zipStat)
      throw new NotFoundException(
        `Backup archive is missing on disk: ${backup.filename}`,
      );
    const { free } = await this.indexer.diskFree();
    if (free < zipStat.size * 2) {
      throw new HttpException(
        `Not enough disk space to restore (~${((zipStat.size * 2) / 1024 ** 3).toFixed(1)} GB needed)`,
        507,
      );
    }

    if (task) task.step('Stopping server');
    await this.lifecycle.stopServer(serverId, { actor }).catch(() => {});
    // NEVER rm -rf under a live container: verify the container really stopped.
    const info = await this.containers
      .inspectStatus(serverId)
      .catch(() => ({ exists: false, status: 'stopped' as const }));
    if (
      info.exists &&
      ['running', 'starting', 'unhealthy'].includes(info.status)
    ) {
      throw new ConflictException(
        'The server did not stop — restore aborted to avoid corrupting the live world. Stop it manually and retry.',
      );
    }

    if (!skipSafety) {
      if (task) task.step('Creating safety backup');
      await this.createBackup(serverId, {
        reason: PRE_RESTORE_REASON,
        actor,
        note: `Safety backup before restoring ${backup.filename}`,
        task: null,
      });
    }

    if (task) task.step('Extracting backup');
    const serverDir = this.pathGuard.dataPath('servers', serverId);
    await fsp.rm(serverDir, { recursive: true, force: true });
    await fsp.mkdir(serverDir, { recursive: true });
    await this.archive.extractZip(
      this.pathGuard.dataPath(backup.relPath),
      serverDir,
    );

    this.events.recordEvent({
      serverId,
      actor,
      type: 'backup-restored',
      summary: `Restored backup ${backup.filename}`,
    });
    this.indexer.scan().catch(() => {});
    return { ok: true };
  }

  async deleteBackup(
    backupId: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<{ freedBytes: number }> {
    const [backup] = await this.db
      .select()
      .from(backups)
      .where(eq(backups.id, backupId))
      .limit(1);
    if (!backup) return { freedBytes: 0 };
    await fsp.rm(this.pathGuard.dataPath(backup.relPath), { force: true });
    await this.db.delete(backups).where(eq(backups.id, backupId));
    this.events.recordEvent({
      serverId: backup.serverId,
      actor,
      type: 'backup-deleted',
      summary: `Backup deleted: ${backup.filename} (${(backup.sizeBytes / 1024 ** 3).toFixed(2)} GB freed)`,
    });
    return { freedBytes: backup.sizeBytes };
  }

  /** 1-120 chars, no path separators/`.`/`..`/control chars — a display label, never a filesystem path. */
  private cleanBackupName(raw: string): string {
    const name = raw.trim();
    if (!name || name.length > 120) {
      throw new BadRequestException('Use a name between 1 and 120 characters.');
    }
    if (/[\\/]/.test(name)) {
      throw new BadRequestException(
        'Backup names cannot contain path separators.',
      );
    }
    // eslint-disable-next-line no-control-regex -- intentionally rejects control chars
    if (name === '.' || name === '..' || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new BadRequestException('That backup name is not allowed.');
    }
    return name;
  }

  /**
   * Give a backup a custom display name. Purely cosmetic: it never touches
   * the archive's `filename`/`relPath` on disk, and has no bearing on
   * retention bucketing or pruning — a renamed backup is pruned exactly as
   * it would have been under its generated name. Pass an empty/blank
   * `name` to clear the custom name (falls back to displaying `filename`).
   */
  async renameBackup(
    backupId: string,
    name: string,
    { actor = 'system' }: { actor?: string } = {},
  ) {
    const [backup] = await this.db
      .select()
      .from(backups)
      .where(eq(backups.id, backupId))
      .limit(1);
    if (!backup) throw new NotFoundException('Backup not found');

    const clean = name.trim() ? this.cleanBackupName(name) : null;
    if (clean === (backup.customName ?? null)) return backup;

    await this.db
      .update(backups)
      .set({ customName: clean })
      .where(eq(backups.id, backupId));
    this.events.recordEvent({
      serverId: backup.serverId,
      actor,
      type: 'backup-renamed',
      summary: clean
        ? `Backup renamed: ${backup.filename} → ${clean}`
        : `Backup name cleared: ${backup.filename}`,
      details: { from: backup.customName ?? null, to: clean },
    });
    const [updated] = await this.db
      .select()
      .from(backups)
      .where(eq(backups.id, backupId))
      .limit(1);
    return updated!;
  }

  /**
   * Keep the newest N per reason bucket (see `RETENTION_BUCKETS`); older ones
   * in each bucket are pruned. Pruning is strictly PER BUCKET, never global:
   * a `pre-restore` safety snapshot must never be able to evict a `manual`
   * backup the user deliberately kept, and vice versa.
   *
   * On top of the count buckets, two panel-wide ceilings from
   * `SettingsService.getBackupRetentionCeilings()` (both opt-in, 0 = off)
   * are applied afterward, across the WHOLE server (not per bucket):
   *   - `maxAgeDays`: drop anything older than N days.
   *   - `maxTotalGb`: drop oldest-first (pre-restore, then scheduled, then
   *     everything else, within an age tier) until the server's total
   *     backup size is back under the cap.
   * In every pass — buckets, age, size — the single newest backup for the
   * server is never a candidate: a server must never end up with zero
   * backups just because it went quiet or its world grew past a ceiling.
   *
   * Each deletion is isolated (one failure — a transient DB error, an EACCES
   * on the file — must not stop the rest from being pruned) and the whole
   * method never throws: it runs after a backup that already succeeded and is
   * already recorded, so a retention problem must never surface as that call
   * failing. Returns how many rows were actually deleted.
   */
  async pruneRetention(
    serverId: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<number> {
    let deleted = 0;
    const drop = async (id: string) => {
      try {
        await this.deleteBackup(id, { actor });
        deleted++;
      } catch (err) {
        console.error(
          `[backup] retention: could not delete ${id} for ${serverId}: ${(err as Error).message}`,
        );
      }
    };

    // 1) Per-reason count caps.
    for (const [reason, keep] of RETENTION_BUCKETS) {
      const rows = await this.db
        .select({ id: backups.id })
        .from(backups)
        .where(and(eq(backups.serverId, serverId), eq(backups.reason, reason)))
        // id is the tiebreaker so two rows sharing a created_at (the column is
        // seconds-resolution text) still order deterministically.
        .orderBy(desc(backups.createdAt), desc(backups.id));
      // Sliced in JS rather than with SQL OFFSET: a bare OFFSET with no LIMIT
      // is a syntax error in SQLite, and the `LIMIT -1` workaround for it is
      // in turn rejected by Postgres — see schema/DUAL_DIALECT_NOTES.md. A
      // bucket holds tens of rows, so the row count is never a concern.
      const stale = rows.slice(keep);
      for (const b of stale) await drop(b.id);
    }

    // 2) & 3) Age / size ceilings, evaluated against what's left after the
    // count-bucket pass above (a fresh read, not the pre-pass snapshot).
    const ceilings = await this.settings.getBackupRetentionCeilings();
    if (ceilings.maxAgeDays > 0 || ceilings.maxTotalGb > 0) {
      const rows = await this.db
        .select({
          id: backups.id,
          reason: backups.reason,
          sizeBytes: backups.sizeBytes,
          createdAt: backups.createdAt,
        })
        .from(backups)
        .where(eq(backups.serverId, serverId))
        // Newest first; id as a deterministic tiebreaker (see above).
        .orderBy(desc(backups.createdAt), desc(backups.id));
      const newestId = rows[0]?.id;

      // Age ceiling: anything older than the cutoff, except the newest.
      if (ceilings.maxAgeDays > 0) {
        const cutoff = Date.now() - ceilings.maxAgeDays * 24 * 60 * 60 * 1000;
        for (const r of rows) {
          if (r.id === newestId) continue;
          const ts = Date.parse(r.createdAt.replace(' ', 'T') + 'Z');
          if (Number.isFinite(ts) && ts < cutoff) await drop(r.id);
        }
      }

      // Size ceiling: oldest-first, sacrificing pre-restore/scheduled before
      // manual/pre-update, until the server's total is back under the cap.
      // Re-reads rows still standing after the age pass rather than reusing
      // the earlier snapshot, so the two ceilings compose correctly.
      if (ceilings.maxTotalGb > 0) {
        const remaining = await this.db
          .select({
            id: backups.id,
            reason: backups.reason,
            sizeBytes: backups.sizeBytes,
            createdAt: backups.createdAt,
          })
          .from(backups)
          .where(eq(backups.serverId, serverId))
          .orderBy(desc(backups.createdAt), desc(backups.id));
        const stillNewestId = remaining[0]?.id;
        const capBytes = ceilings.maxTotalGb * 1024 ** 3;
        let total = remaining.reduce((sum, r) => sum + (r.sizeBytes || 0), 0);
        const rank = (reason: string) =>
          reason === 'pre-restore' ? 0 : reason === 'scheduled' ? 1 : 2;
        const oldestFirst = [...remaining].sort(
          (a, b) =>
            Date.parse(a.createdAt.replace(' ', 'T') + 'Z') -
            Date.parse(b.createdAt.replace(' ', 'T') + 'Z'),
        );
        const order = [...oldestFirst].sort(
          (a, b) => rank(a.reason) - rank(b.reason),
        );
        for (const r of order) {
          if (total <= capBytes) break;
          if (r.id === stillNewestId) continue;
          await drop(r.id);
          total -= r.sizeBytes || 0;
        }
      }
    }

    return deleted;
  }

  private zipDirectory(
    sourceDir: string,
    outFile: string,
    {
      onProgress = null,
    }: { onProgress?: ((processedBytes: number) => void) | null } = {},
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outFile);
      const archive = new ZipArchive({ zlib: { level: 6 } });
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        try {
          output.destroy();
        } catch {
          /* */
        }
        fs.rm(outFile, { force: true }, () => reject(err));
      };
      output.on('close', () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      output.on('error', fail);
      archive.on('error', fail);
      if (onProgress)
        archive.on('progress', (d: { fs: { processedBytes: number } }) =>
          onProgress(d.fs.processedBytes),
        );
      archive.pipe(output);
      archive.directory(sourceDir, false);
      archive.finalize();
    });
  }
}
