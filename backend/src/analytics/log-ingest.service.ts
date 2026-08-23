import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { eq, and, desc, lt, isNull, isNotNull } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { playerEvents, playerSessions } from '../db/schema';
import { ServerQueryService } from '../servers/server-query.service';
import { DockerLogsService } from '../docker/docker-logs.service';
import { LogClassifierService } from './log-classifier.service';
import { ChatCommandsService } from '../chat/chat-commands.service';
import type { ClassifiedEvent } from './types';

const RUNNING = new Set(['running', 'starting', 'unhealthy']);
const DEDUPE_WINDOW_MS = 5000; // paired lines (logged-in/joined, lost-connection/left)

interface LogTap {
  stop: () => void;
  buf: string;
}

// Docker prepends this RFC3339(Nano) receive time to each line when
// `timestamps: true` — the authoritative event time, independent of the
// container's TZ. (nanoseconds trimmed to ms for JS Date.)
const DOCKER_TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s([\s\S]*)$/;

interface SplitTimestamp {
  ts: string | null;
  rest: string;
}

/**
 * Player-event ingestion: live log taps on every running server plus a
 * one-shot backfill from the container's recent log buffer. Every
 * classified line becomes a player_events row; join/leave events also
 * maintain player_sessions. Ports src/analytics/ingest.ts.
 */
@Injectable()
export class LogIngestService implements OnModuleInit {
  private readonly logger = new Logger(LogIngestService.name);
  private readonly taps = new Map<string, LogTap>(); // serverId -> { stop, buf }
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;

  constructor(
    private readonly dbService: DbService,
    private readonly servers: ServerQueryService,
    private readonly logs: DockerLogsService,
    private readonly classifier: LogClassifierService,
    private readonly chatCommands: ChatCommandsService
  ) {}

  private get db() {
    return this.dbService.db;
  }

  onModuleInit(): void {
    // Fire-and-forget, matching legacy's boot-time `startIngest()` call —
    // must never block app startup on the first tap-sync round.
    this.startIngest().catch((err) =>
      this.logger.error(`initial tap sync failed: ${err instanceof Error ? err.message : err}`)
    );
  }

  /** Split a Docker-timestamped line into { ts: ISO|null, rest: line }. */
  private splitDockerTimestamp(line: string): SplitTimestamp {
    const m = DOCKER_TS_RE.exec(line);
    if (!m) return { ts: null, rest: line };
    const iso = (m[1] ?? '').replace(/(\.\d{3})\d*Z$/, '$1Z'); // trim ns → ms
    const d = new Date(iso);
    return { ts: Number.isNaN(d.getTime()) ? null : d.toISOString(), rest: m[2] ?? '' };
  }

  /**
   * Fallback timestamp from the log line's HH:MM:SS when Docker's timestamp
   * is absent: today's date + time; a result more than a minute in the
   * future means the line is from yesterday. Used only for lines with no
   * Docker prefix.
   */
  private buildTs(hms: string | null | undefined, now: Date = new Date()): string {
    if (!hms) return now.toISOString();
    const [h, m, s] = hms.split(':').map(Number);
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h ?? 0, m ?? 0, s ?? 0));
    if (d.getTime() - now.getTime() > 60_000) d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString();
  }

  private openSession(serverId: string, player: string, ts: string): void {
    // A dangling open session means we missed the leave — close it at the new join.
    this.db
      .update(playerSessions)
      .set({ endedAt: ts })
      .where(and(eq(playerSessions.serverId, serverId), eq(playerSessions.player, player), isNull(playerSessions.endedAt)))
      .run();
    this.db
      .insert(playerSessions)
      .values({ serverId, player, startedAt: ts })
      .onConflictDoNothing()
      .run();
  }

  private closeSession(serverId: string, player: string, ts: string): void {
    this.db
      .update(playerSessions)
      .set({ endedAt: ts })
      .where(and(eq(playerSessions.serverId, serverId), eq(playerSessions.player, player), isNull(playerSessions.endedAt)))
      .run();
  }

  /** Close every open session for a server (server stopped / log tap ended). */
  closeAllSessions(serverId: string, ts: string = new Date().toISOString()): void {
    this.db
      .update(playerSessions)
      .set({ endedAt: ts })
      .where(and(eq(playerSessions.serverId, serverId), isNull(playerSessions.endedAt)))
      .run();
  }

  /**
   * Insert one classified event. Collapses paired join/leave variants that
   * land within DEDUPE_WINDOW_MS of an identical-type event for the same
   * player. Returns true when a row was inserted.
   */
  private insertEvent(
    serverId: string,
    evt: ClassifiedEvent,
    ts: string,
    raw: string,
    { sessions = true }: { sessions?: boolean } = {}
  ): boolean {
    if (evt.type === 'join' || evt.type === 'leave') {
      const prev = this.db
        .select({ ts: playerEvents.ts, type: playerEvents.type, target: playerEvents.target })
        .from(playerEvents)
        .where(and(eq(playerEvents.serverId, serverId), eq(playerEvents.player, evt.player)))
        .orderBy(desc(playerEvents.id))
        .limit(1)
        .get();
      if (prev && prev.type === evt.type && Math.abs(Date.parse(String(prev.ts)) - Date.parse(ts)) <= DEDUPE_WINDOW_MS) {
        return false;
      }
    }
    this.db
      .insert(playerEvents)
      .values({ serverId, ts, type: evt.type, player: evt.player, target: evt.target, message: evt.message, raw })
      .run();
    if (sessions) {
      if (evt.type === 'join') this.openSession(serverId, evt.player, ts);
      else if (evt.type === 'leave') this.closeSession(serverId, evt.player, ts);
    }
    return true;
  }

  private handleLine(serverId: string, line: string): void {
    const { ts: dockerTs, rest } = this.splitDockerTimestamp(line.replace(/\r$/, ''));
    const raw = rest;
    const evt = this.classifier.classify(raw);
    if (!evt) return;
    try {
      this.insertEvent(serverId, evt, dockerTs || this.buildTs(evt.time), raw);
    } catch (err) {
      this.logger.error(`insert failed for ${serverId}: ${err instanceof Error ? err.message : err}`);
    }
    // Custom chat commands (!rtp2 …): fire-and-forget — a broken command
    // handler must never break log ingestion.
    if (evt.type === 'chat' && evt.player !== '[Server]') {
      this.chatCommands.handleChat(serverId, evt.player, evt.message).catch((err) => {
        this.logger.error(`chat-command handling failed for ${serverId}: ${err instanceof Error ? err.message : err}`);
      });
    }
  }

  private async attach(serverId: string): Promise<void> {
    // timestamps:true so each line carries Docker's authoritative UTC receive
    // time — TZ-independent, unlike the container's bare HH:MM:SS console prefix.
    const { stream, stop } = await this.logs.followLogs(serverId, { tail: 0, timestamps: true });
    const tap: LogTap = { stop, buf: '' };
    this.taps.set(serverId, tap);
    stream.on('data', (chunk: Buffer) => {
      tap.buf += chunk.toString('utf8');
      let nl;
      while ((nl = tap.buf.indexOf('\n')) !== -1) {
        const line = tap.buf.slice(0, nl);
        tap.buf = tap.buf.slice(nl + 1);
        if (line.trim()) this.handleLine(serverId, line);
      }
    });
    const cleanup = () => {
      if (this.taps.get(serverId) !== tap) return;
      this.taps.delete(serverId);
      this.closeAllSessions(serverId);
    };
    stream.on('end', cleanup);
    stream.on('close', cleanup);
    stream.on('error', cleanup);
  }

  /** Attach taps to running servers, drop taps for stopped ones. */
  private async syncTaps(): Promise<void> {
    // Re-entrancy guard: a slow attach() can outlive the 60s poll interval and
    // a second concurrent sync would double-attach taps (duplicate events,
    // leaked streams).
    if (this.syncing) return;
    this.syncing = true;
    try {
      const running = new Set(this.servers.listServers().filter((s) => RUNNING.has(s.status)).map((s) => s.id));
      for (const [id, tap] of this.taps) {
        if (!running.has(id)) tap.stop(); // stream end handler does the cleanup
      }
      for (const id of running) {
        if (!this.taps.has(id)) {
          await this.attach(id).catch((err) =>
            this.logger.error(`tap ${id} failed: ${err instanceof Error ? err.message : err}`)
          );
        }
      }
    } finally {
      this.syncing = false;
    }
  }

  /** Start live ingestion; re-syncs taps every 60 s as servers start/stop. */
  async startIngest(): Promise<void> {
    await this.syncTaps().catch((err) =>
      this.logger.error(`initial tap sync failed: ${err instanceof Error ? err.message : err}`)
    );
    this.pollTimer = setInterval(() => this.syncTaps().catch(() => {}), 60_000);
    this.pollTimer.unref?.();
  }

  stopIngest(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    for (const tap of this.taps.values()) tap.stop();
  }

  /**
   * One-shot backfill from the container's recent log buffer. Skips lines
   * older than the newest recorded event and exact raw duplicates at the
   * same second. Sessions are not touched — replayed historical joins would
   * reopen them.
   */
  async backfillFromLogs(serverId: string, { tail = 5000 }: { tail?: number } = {}): Promise<{ inserted: number }> {
    const raw = await this.logs.fetchLogs(serverId, { tail, timestamps: true });
    const newest = this.db
      .select({ ts: playerEvents.ts })
      .from(playerEvents)
      .where(eq(playerEvents.serverId, serverId))
      .orderBy(desc(playerEvents.ts))
      .limit(1)
      .get();
    const now = new Date();
    let inserted = 0;
    for (const rawLine of raw.split(/\r?\n/)) {
      if (!rawLine.trim()) continue;
      const { ts: dockerTs, rest: line } = this.splitDockerTimestamp(rawLine);
      const evt = this.classifier.classify(line);
      if (!evt) continue;
      const ts = dockerTs || this.buildTs(evt.time, now);
      if (newest && ts < String(newest.ts)) continue;
      const dup = this.db
        .select({ one: playerEvents.id })
        .from(playerEvents)
        .where(and(eq(playerEvents.serverId, serverId), eq(playerEvents.ts, ts), eq(playerEvents.raw, line)))
        .get();
      if (dup) continue;
      if (this.insertEvent(serverId, evt, ts, line, { sessions: false })) inserted++;
    }
    return { inserted };
  }

  /** Prune old timeline rows and closed sessions. Returns deleted counts. */
  pruneOlderThan(days: number): { events: number; sessions: number } {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const eventsResult = this.db.delete(playerEvents).where(lt(playerEvents.ts, cutoff)).run();
    const sessionsResult = this.db
      .delete(playerSessions)
      .where(and(isNotNull(playerSessions.endedAt), lt(playerSessions.endedAt, cutoff)))
      .run();
    return { events: Number(eventsResult.changes), sessions: Number(sessionsResult.changes) };
  }
}
