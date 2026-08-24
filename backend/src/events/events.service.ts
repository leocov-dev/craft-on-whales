import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import {
  and,
  desc,
  eq,
  like,
  lt,
  or,
  type InferSelectModel,
} from 'drizzle-orm';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { events } from '../db/schema';

type EventRow = InferSelectModel<typeof events>;

export interface HydratedEvent extends Omit<EventRow, 'detailsJson'> {
  details: Record<string, unknown>;
}

export interface RecordEventOptions {
  /** null/undefined for panel-global events */
  serverId?: string | null;
  /** username | 'system' | 'scheduler' */
  actor?: string;
  /** kebab-case event type ('started', 'config-changed', …) */
  type: string;
  /** human-readable one-liner */
  summary: string;
  /** structured payload (diffs, versions, sizes…) */
  details?: Record<string, unknown>;
  /** raw text to persist alongside the event */
  logExcerpt?: string | null;
}

export interface ListEventsOptions {
  serverId?: string | null;
  type?: string | null;
  limit?: number;
  offset?: number;
}

export interface ExportEventsOptions {
  format?: 'json' | 'csv';
  q?: string;
  type?: string;
}

export interface ExportedEvents {
  filename: string;
  contentType: string;
  body: string;
}

const EXPORT_LIMIT = 10000;

/**
 * Action-history service. Every panel feature routes its notable actions
 * through recordEvent() so history can never drift out of sync with
 * behavior. @Global — nearly every other service depends on this one, and
 * it has no dependents of its own (a true cross-cutting leaf).
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly dbService: DbService,
  ) {}

  private dataPath(rel: string): string {
    return path.join(this.config.dataDir, rel);
  }

  private writeExcerpt(
    serverId: string | null,
    type: string,
    logExcerpt: string,
  ): string {
    // nanoid suffix: two events of the same type in the same millisecond
    // must not overwrite each other's captured logs.
    const rel = path.posix.join(
      'logs',
      serverId || '_panel',
      'events',
      `${Date.now()}-${type}-${nanoid(4)}.log`,
    );
    const abs = this.dataPath(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    // Cap captures at 256 KB so a runaway log can't flood the data dir.
    fs.writeFileSync(abs, logExcerpt.slice(-256 * 1024));
    return rel;
  }

  /**
   * Record an event — fire-and-forget by design. Audit logging is called
   * from ~120 call sites across nearly every service; almost none of them
   * need the new row's id (the one exception, crashes.service.ts, uses
   * recordEventAndGetId below instead) or need to block on the write
   * completing. Keeping this callable without `await` avoids threading
   * async through those ~120 unrelated call sites. A failed write is
   * logged, not thrown — same as before this only mattered for the (never
   * exercised) case of the events table itself being broken.
   */
  recordEvent(opts: RecordEventOptions): void {
    this.insertEvent(opts).catch((err: unknown) => {
      this.logger.error(
        `failed to record event (type=${opts.type}): ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /** Same as recordEvent, but awaited and returns the new event's id (crashes.service.ts links a crash report to its event row). */
  async recordEventAndGetId(opts: RecordEventOptions): Promise<number> {
    return this.insertEvent(opts);
  }

  private async insertEvent({
    serverId = null,
    actor = 'system',
    type,
    summary,
    details = {},
    logExcerpt = null,
  }: RecordEventOptions): Promise<number> {
    const excerptRel = logExcerpt
      ? this.writeExcerpt(serverId, type, logExcerpt)
      : null;
    const [row] = await this.dbService.db
      .insert(events)
      .values({
        serverId,
        actor,
        type,
        summary,
        detailsJson: JSON.stringify(details),
        logExcerptPath: excerptRel,
      })
      .returning({ id: events.id });
    return row!.id;
  }

  async listEvents({
    serverId = null,
    type = null,
    limit = 50,
    offset = 0,
  }: ListEventsOptions = {}): Promise<HydratedEvent[]> {
    const where = [
      ...(serverId ? [eq(events.serverId, serverId)] : []),
      ...(type ? [eq(events.type, type)] : []),
    ];
    const rows = await this.dbService.db
      .select()
      .from(events)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(events.id))
      .limit(limit)
      .offset(offset);
    return rows.map((row) => this.hydrate(row));
  }

  async getEvent(id: number): Promise<HydratedEvent | null> {
    const [row] = await this.dbService.db
      .select()
      .from(events)
      .where(eq(events.id, id))
      .limit(1);
    return row ? this.hydrate(row) : null;
  }

  readExcerpt(event: Pick<EventRow, 'logExcerptPath'>): string | null {
    if (!event.logExcerptPath) return null;
    try {
      return fs.readFileSync(this.dataPath(event.logExcerptPath), 'utf8');
    } catch {
      return null;
    }
  }

  private hydrate(row: EventRow): HydratedEvent {
    return { ...row, details: this.safeParse(row.detailsJson) };
  }

  private safeParse(json: string | null | undefined): Record<string, unknown> {
    try {
      return JSON.parse(json || '{}') as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /** Export events as a downloadable JSON or CSV string. */
  async exportEvents(
    serverId: string | null | undefined,
    { format = 'json', q = '', type = '' }: ExportEventsOptions = {},
  ): Promise<ExportedEvents> {
    const fmt = format === 'csv' ? 'csv' : 'json';
    const rows = await this.dbService.db
      .select({
        id: events.id,
        createdAt: events.createdAt,
        serverId: events.serverId,
        actor: events.actor,
        type: events.type,
        summary: events.summary,
        detailsJson: events.detailsJson,
      })
      .from(events)
      .where(this.buildExportWhere(serverId, type, q))
      .orderBy(desc(events.id))
      .limit(EXPORT_LIMIT);
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `events-${serverId || 'all'}-${stamp}.${fmt}`;
    if (fmt === 'json') {
      const body = JSON.stringify(
        rows.map((r) => ({
          ...r,
          details: this.safeParse(r.detailsJson),
          detailsJson: undefined,
        })),
        null,
        2,
      );
      return { filename, contentType: 'application/json', body };
    }
    const esc = (v: unknown) => {
      let s: string;
      switch (typeof v) {
        case 'undefined':
          s = '';
          break;
        case 'string':
          s = v;
          break;
        case 'number':
        case 'boolean':
        case 'bigint':
          s = String(v);
          break;
        default:
          s = v == null ? '' : JSON.stringify(v);
      }
      return `"${s.replace(/"/g, '""')}"`;
    };
    const body = ['id,created_at,server_id,actor,type,summary']
      .concat(
        rows.map((r) =>
          [r.id, r.createdAt, r.serverId || '', r.actor, r.type, r.summary]
            .map(esc)
            .join(','),
        ),
      )
      .join('\r\n');
    return { filename, contentType: 'text/csv', body };
  }

  private buildExportWhere(
    serverId: string | null | undefined,
    type: string,
    q: string,
  ) {
    const clauses = [
      ...(serverId ? [eq(events.serverId, serverId)] : []),
      ...(type ? [eq(events.type, type)] : []),
      ...(q
        ? [
            or(
              like(events.summary, `%${q}%`),
              like(events.actor, `%${q}%`),
              like(events.type, `%${q}%`),
            )!,
          ]
        : []),
    ];
    return clauses.length ? and(...clauses) : undefined;
  }

  /** Delete events (and their captured log excerpts) older than `days`. */
  async pruneEvents(
    days: number,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<{ removed: number }> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');
    const rows = await this.dbService.db
      .select({ id: events.id, logExcerptPath: events.logExcerptPath })
      .from(events)
      .where(lt(events.createdAt, cutoff));
    for (const row of rows) {
      if (row.logExcerptPath) {
        try {
          fs.rmSync(this.dataPath(row.logExcerptPath), { force: true });
        } catch {
          /* best-effort */
        }
      }
    }
    await this.dbService.db.delete(events).where(lt(events.createdAt, cutoff));
    this.recordEvent({
      actor,
      type: 'events-pruned',
      summary: `Event history pruned: ${rows.length} event(s) older than ${days} days removed`,
    });
    return { removed: rows.length };
  }
}
