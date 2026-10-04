import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { DbService } from '../db/db.service';
import { PathGuardService } from '../storage/path-guard.service';

/** How many nightly snapshots to keep. */
export const PANEL_DB_SNAPSHOTS_KEEP = 14;
const SNAPSHOT_RE = /^panel-\d{4}(-\d{2}){5}\.db$/;

/**
 * Runs in a worker thread so a slow rewrite of a large database can't stall the
 * event loop. `VACUUM INTO` reads a consistent snapshot of the current state
 * (including committed WAL frames the panel's own connection wrote) and emits a
 * self-contained single file, so no manual checkpoint is needed. The copy is
 * quick-checked before it is reported good. Inline (`eval`) so there is no
 * separate worker file to ship in the build output.
 */
const SNAPSHOT_WORKER = `
const { workerData, parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
try {
  const src = new DatabaseSync(workerData.src);
  src.exec('PRAGMA busy_timeout = 10000');
  src.prepare('VACUUM INTO ?').run(workerData.dest);
  src.close();
  const copy = new DatabaseSync(workerData.dest, { readOnly: true });
  const rows = copy.prepare('PRAGMA quick_check').all().map((r) => String(Object.values(r)[0]));
  copy.close();
  parentPort.postMessage({ ok: rows.length === 1 && rows[0] === 'ok', error: rows.join('; ') });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String((err && err.message) || err) });
}
`;

export interface SnapshotResult {
  file: string;
  bytes: number;
  elapsedMs: number;
  pruned: number;
}

/**
 * Health of, and backups for, the one file that holds all panel state (users,
 * 2FA, schedules, pins, history). Server backups only cover world data, so
 * without this the panel DB has no backup at all.
 *
 * SQLite only. Under Postgres the database lives outside the panel's data
 * directory and is the operator's to back up (`pg_dump`); the panel does not
 * shell out to it. See `db/DRIZZLE_NOTES.md`.
 */
@Injectable()
export class PanelDbService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PanelDbService.name);

  constructor(
    private readonly db: DbService,
    private readonly pathGuard: PathGuardService,
  ) {}

  /**
   * Fast read-only sanity check, run once after migrations. A corrupt database
   * will not fix itself, so say so loudly before more writes pile on top.
   */
  onApplicationBootstrap(): void {
    if (this.db.driver !== 'sqlite') return;
    try {
      const rows = this.db.quickCheck() ?? [];
      if (rows.length === 1 && rows[0] === 'ok') return;
      this.logger.error(
        `The SQLite integrity check did not pass: ${rows.slice(0, 5).join('; ')}`,
      );
      this.logger.error(
        'Stop the panel and restore the newest good copy from data/backups/_panel (replace data/panel.db), then start it again.',
      );
    } catch (err) {
      this.logger.error(
        `The SQLite integrity check could not run: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Snapshot the database into `data/backups/_panel` and drop the oldest extras. */
  async snapshot(): Promise<SnapshotResult | null> {
    const src = this.db.sqliteFile;
    if (!src) return null;

    const dir = this.pathGuard.dataPath('backups', '_panel');
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const dest = path.join(dir, `panel-${stamp}.db`);
    // Written under a temp name and renamed, so a half-written copy can never
    // be mistaken for a good snapshot (and never counts toward retention).
    const partial = `${dest}.partial`;
    await fsp.rm(partial, { force: true });

    const started = Date.now();
    try {
      await this.runWorker(src, partial);
      // Holds password hashes, encrypted secrets and 2FA state.
      await fsp.chmod(partial, 0o600);
      await fsp.rename(partial, dest);
    } catch (err) {
      await fsp.rm(partial, { force: true }).catch(() => {});
      throw err;
    }
    return {
      file: path.basename(dest),
      bytes: (await fsp.stat(dest)).size,
      elapsedMs: Date.now() - started,
      pruned: await this.pruneSnapshots(dir),
    };
  }

  private async pruneSnapshots(dir: string): Promise<number> {
    const snaps = (await fsp.readdir(dir))
      .filter((f) => SNAPSHOT_RE.test(f))
      .sort();
    const stale = snaps.slice(
      0,
      Math.max(0, snaps.length - PANEL_DB_SNAPSHOTS_KEEP),
    );
    for (const f of stale) await fsp.rm(path.join(dir, f), { force: true });
    return stale.length;
  }

  private runWorker(src: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(src)) {
        reject(new Error('panel database file not found'));
        return;
      }
      const worker = new Worker(SNAPSHOT_WORKER, {
        eval: true,
        workerData: { src, dest },
      });
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        void worker.terminate();
        if (err) reject(err);
        else resolve();
      };
      worker.once('message', (msg: { ok: boolean; error?: string }) =>
        done(
          msg.ok
            ? undefined
            : new Error(
                `panel database snapshot failed: ${msg.error ?? 'unknown error'}`,
              ),
        ),
      );
      worker.once('error', (err: Error) => done(err));
      worker.once('exit', (code) => {
        if (code !== 0)
          done(new Error(`snapshot worker exited with code ${code}`));
      });
    });
  }
}
