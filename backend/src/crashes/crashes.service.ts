import { Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { and, desc, eq, lt } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { DbService } from '../db/db.service';
import { EventsService } from '../events/events.service';
import { PathGuardService } from '../storage/path-guard.service';
import { ServerQueryService } from '../servers/server-query.service';
import { crashReports } from '../db/schema';
import { CrashParserService } from './crash-parser.service';

type CrashRow = typeof crashReports.$inferSelect;

export interface DecoratedCrash extends CrashRow {
  suspected: string[];
}

/**
 * Crash-report service: watches each server's crash-reports/ dir (plus JVM
 * hs_err_pid*.log files in the server root), indexes new reports with a
 * parsed one-line summary + suspected mods, and links each to a history
 * event. Ports legacy `src/crashes/index.ts` (parsing logic split out into
 * `CrashParserService`). No `forwardRef()` needed — `servers.ts` never
 * requires crashes back, so `ServerQueryService` is a plain one-directional
 * constructor dependency.
 */
@Injectable()
export class CrashesService implements OnModuleDestroy {
  private watcherTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly dbService: DbService,
    private readonly pathGuard: PathGuardService,
    private readonly events: EventsService,
    private readonly serverQuery: ServerQueryService,
    private readonly parser: CrashParserService
  ) {}

  private get db() {
    return this.dbService.db;
  }

  private absPathFor(serverId: string, filename: string): string {
    // hs_err files live in the server root; crash reports in crash-reports/.
    return filename.startsWith('hs_err')
      ? this.pathGuard.dataPath('servers', serverId, filename)
      : this.pathGuard.dataPath('servers', serverId, 'crash-reports', filename);
  }

  private async listCandidateFiles(serverId: string): Promise<string[]> {
    const out: string[] = [];
    const crashDir = this.pathGuard.dataPath('servers', serverId, 'crash-reports');
    const rootDir = this.pathGuard.dataPath('servers', serverId);
    try {
      for (const name of await fsp.readdir(crashDir)) {
        if (name.endsWith('.txt')) out.push(name);
      }
    } catch {
      /* no crash-reports dir yet */
    }
    try {
      for (const name of await fsp.readdir(rootDir)) {
        if (/^hs_err_pid.*\.log$/.test(name)) out.push(name);
      }
    } catch {
      /* server dir missing */
    }
    return out;
  }

  /** Scan one server for crash files not yet indexed; parse + insert + record event. */
  async scanServer(serverId: string): Promise<string[]> {
    const inserted: string[] = [];
    for (const filename of await this.listCandidateFiles(serverId)) {
      const existing = this.db
        .select({ id: crashReports.id })
        .from(crashReports)
        .where(and(eq(crashReports.serverId, serverId), eq(crashReports.filename, filename)))
        .get();
      if (existing) continue;

      const abs = this.absPathFor(serverId, filename);
      let stat, text;
      try {
        stat = await fsp.stat(abs);
        text = await fsp.readFile(abs, 'utf8');
      } catch {
        continue; // deleted between readdir and read
      }

      const parsed = filename.startsWith('hs_err') ? this.parser.parseHsErr(text) : this.parser.parseCrashReport(text);
      const id = `cr_${nanoid(8)}`;
      this.db
        .insert(crashReports)
        .values({
          id,
          serverId,
          filename,
          fileMtime: stat.mtime.toISOString(),
          sizeBytes: stat.size,
          summary: parsed.summary,
          exception: parsed.exception,
          suspectedJson: JSON.stringify(parsed.suspects),
        })
        .run();
      const eventId = this.events.recordEvent({
        serverId,
        type: 'crash-report',
        actor: 'system',
        summary: `New crash report: ${filename} — ${parsed.exception || parsed.summary}`,
        details: { crashId: id },
      });
      this.db.update(crashReports).set({ eventId }).where(eq(crashReports.id, id)).run();
      inserted.push(id);
    }
    return inserted;
  }

  /** Scan every (non-deleted) server; per-server errors are swallowed. */
  async scanAll(): Promise<void> {
    for (const server of this.serverQuery.listServers()) {
      try {
        await this.scanServer(server.id);
      } catch (err) {
        console.error(`[crashes] scan failed for ${server.id}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  /** Start the background watcher (immediate scan + interval). */
  startCrashWatcher({ intervalMs = 30000 }: { intervalMs?: number } = {}): void {
    this.stopCrashWatcher();
    this.scanAll().catch((err) => console.error('[crashes] initial scan failed:', err instanceof Error ? err.message : err));
    this.watcherTimer = setInterval(() => {
      this.scanAll().catch((err) => console.error('[crashes] scan failed:', err instanceof Error ? err.message : err));
    }, intervalMs);
    this.watcherTimer.unref();
  }

  stopCrashWatcher(): void {
    if (this.watcherTimer) {
      clearInterval(this.watcherTimer);
      this.watcherTimer = null;
    }
  }

  onModuleDestroy(): void {
    this.stopCrashWatcher();
  }

  private decorate(row: CrashRow): DecoratedCrash {
    return { ...row, suspected: JSON.parse(row.suspectedJson || '[]') };
  }

  listCrashes(serverId: string): DecoratedCrash[] {
    return this.db
      .select()
      .from(crashReports)
      .where(eq(crashReports.serverId, serverId))
      .orderBy(desc(crashReports.fileMtime))
      .all()
      .map((row) => this.decorate(row));
  }

  getCrash(crashId: string): DecoratedCrash | null {
    const row = this.db.select().from(crashReports).where(eq(crashReports.id, crashId)).get();
    return row ? this.decorate(row) : null;
  }

  /** Read a report's full text. The filename MUST be one indexed for this server. */
  getCrashText(serverId: string, filename: string): string {
    const row = this.db
      .select({ id: crashReports.id })
      .from(crashReports)
      .where(and(eq(crashReports.serverId, serverId), eq(crashReports.filename, filename)))
      .get();
    if (!row) throw new NotFoundException('Crash report not found');
    return fs.readFileSync(this.absPathFor(serverId, filename), 'utf8');
  }

  markViewed(crashId: string): void {
    this.db.update(crashReports).set({ viewed: true }).where(eq(crashReports.id, crashId)).run();
  }

  /** Delete a report: unlink the file + remove the row + record the event. */
  deleteCrash(crashId: string, { actor = 'system' }: { actor?: string } = {}): { freedBytes: number } {
    const row = this.getCrash(crashId);
    if (!row) throw new NotFoundException('Crash report not found');
    try {
      fs.unlinkSync(this.absPathFor(row.serverId, row.filename));
    } catch {
      /* file already gone — still drop the row */
    }
    this.db.delete(crashReports).where(eq(crashReports.id, crashId)).run();
    this.events.recordEvent({
      serverId: row.serverId,
      type: 'crash-report-deleted',
      actor,
      summary: `Deleted crash report: ${row.filename}`,
      details: { crashId, filename: row.filename, freedBytes: row.sizeBytes },
    });
    return { freedBytes: row.sizeBytes };
  }

  /** Bulk cleanup: delete this server's reports older than `days`. */
  deleteOlderThan(serverId: string, days: number, { actor = 'system' }: { actor?: string } = {}): { deleted: number; freedBytes: number } {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db
      .select({ id: crashReports.id })
      .from(crashReports)
      .where(and(eq(crashReports.serverId, serverId), lt(crashReports.fileMtime, cutoff)))
      .all();
    let freedBytes = 0;
    for (const { id } of rows) {
      freedBytes += this.deleteCrash(id, { actor }).freedBytes;
    }
    return { deleted: rows.length, freedBytes };
  }
}
