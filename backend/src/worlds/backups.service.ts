import {
  HttpException,
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
// @types/archiver has no factory-function signature (only the Archiver class),
// so — matching the legacy code's own untyped require() for this package —
// this stays untyped rather than fighting the types for a call the package
// genuinely supports at runtime.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const archiver = require('archiver');
import { and, desc, eq, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { DbService } from '../db/db.service';
import { ContainerService } from '../docker/container.service';
import { ServerLifecycleService } from '../servers/server-lifecycle.service';
import { PathGuardService } from '../storage/path-guard.service';
import { StorageIndexService } from '../storage/storage-index.service';
import { EventsService } from '../events/events.service';
import { backups, servers } from '../db/schema';
import { WorldArchiveService } from './world-archive.service';
import { WorldSaveLockService } from './world-save-lock.service';

const KEEP_SCHEDULED = 10; // retention: newest N scheduled backups per server

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
        const paused = await this.containers
          .execCapture(serverId, ['rcon-cli', 'save-off'])
          .then(() => true)
          .catch((err: Error) => {
            console.warn(
              `[backup] save-off failed for ${serverId}: ${err.message} — archive may be slightly inconsistent`,
            );
            return false;
          });
        inconsistent = !paused;
        await this.containers
          .execCapture(serverId, ['rcon-cli', 'save-all', 'flush'])
          .catch(() => {});
        await this.archive.sleep(2000);
        try {
          await doArchive();
        } finally {
          await this.containers
            .execCapture(serverId, ['rcon-cli', 'save-on'])
            .catch(() => {});
        }
      });
    } else {
      await doArchive();
    }

    const size = (await fsp.stat(absPath)).size;
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
    this.events.recordEvent({
      serverId,
      actor,
      type: 'backup-created',
      summary: `Backup created (${reason}, ${(size / 1024 ** 3).toFixed(2)} GB)${inconsistent ? ' — WARNING: world saves could not be paused, archive may be slightly inconsistent' : ''}`,
      details: { id, filename, reason, inconsistent },
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
        reason: 'manual',
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

  /** Keep newest N scheduled; manual + pre-update are never auto-pruned. */
  async pruneRetention(
    serverId: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<number> {
    const keepRows = await this.db
      .select({ id: backups.id })
      .from(backups)
      .where(
        and(eq(backups.serverId, serverId), eq(backups.reason, 'scheduled')),
      )
      .orderBy(desc(backups.createdAt))
      .limit(KEEP_SCHEDULED);
    const keepIds = keepRows.map((r) => r.id);
    const allScheduled = await this.db
      .select()
      .from(backups)
      .where(
        and(eq(backups.serverId, serverId), eq(backups.reason, 'scheduled')),
      );
    const stale = keepIds.length
      ? allScheduled.filter((b) => !keepIds.includes(b.id))
      : allScheduled;
    for (const b of stale) await this.deleteBackup(b.id, { actor });
    return stale.length;
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
      const archive = archiver('zip', { zlib: { level: 6 } });
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
