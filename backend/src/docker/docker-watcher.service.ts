import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { servers, events as eventsTable } from '../db/schema';
import { EventsService } from '../events/events.service';
import { DockerConnectionService } from './docker-connection.service';
import { ContainerService, LABEL } from './container.service';
import { DockerLogsService } from './docker-logs.service';

const MAX_RAPID_CRASHES = 3;
const CRASH_WINDOW_MS = 10 * 60 * 1000;

interface DockerEvent {
  status?: string;
  Actor?: {
    Attributes?: Record<string, string>;
  };
}

interface FatalDiagnosis {
  key: string;
  re: RegExp;
  summary: string;
}

/**
 * Docker events watcher: turns container die/start/oom events on managed
 * containers into history events, updates cached status, and drives crash
 * detection with auto-restart backoff.
 *
 * KNOWN GAP: the legacy watcher restarts a crashed server via the guarded
 * server lifecycle (`services/servers.ts`'s `startServer`), not
 * `ContainerService.startContainer` directly, so a watcher-triggered
 * restart can't race a user's own start/recreate/delete and honors
 * `pending_recreate`. `ServersModule` doesn't exist yet in this rewrite
 * (it's next after AuthModule per the plan's migration order) — see the
 * `// TODO(ServersModule)` below. Everything else (event stream, status
 * caching, crash diagnosis, backoff bookkeeping) is fully wired. Once
 * `ServersModule` exists, inject `ServersService` here via `forwardRef()`
 * (this is the one genuine cross-module cycle the plan's require-cycle
 * audit already anticipated for `DockerWatcherService`) and replace the
 * TODO with the real call.
 */
@Injectable()
export class DockerWatcherService implements OnModuleInit {
  private readonly logger = new Logger(DockerWatcherService.name);
  // serverId → recent crash timestamps (for backoff)
  private readonly crashWindows = new Map<string, number[]>();
  private stream: NodeJS.ReadableStream | null = null;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly connection: DockerConnectionService,
    private readonly containers: ContainerService,
    private readonly logs: DockerLogsService,
    private readonly eventsService: EventsService,
    private readonly dbService: DbService,
  ) {}

  onModuleInit(): void {
    this.startWatcher().catch((err: Error) => {
      this.logger.error(
        `initial connect failed, retrying in 5s: ${err.message}`,
      );
      this.retryLater();
    });
  }

  async startWatcher(): Promise<void> {
    if (this.stream) return;
    const docker = this.connection.getDocker();
    const s = await docker.getEvents({
      filters: { type: ['container'], label: ['msm.managed=true'] },
    });
    this.stream = s;
    let buffer = '';
    s.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          this.handleEvent(JSON.parse(line) as DockerEvent).catch(
            (err: Error) => this.logger.error(`[watcher] ${err.message}`),
          );
        } catch {
          /* partial frame */
        }
      }
    });
    const onDrop = () => {
      if (this.stream !== s) return; // stale stream's late event — a newer stream is live
      this.stream = null;
      this.retryLater();
    };
    s.on('error', onDrop);
    s.on('end', onDrop);
    this.logger.log('docker events stream connected');
  }

  /** Schedule a reconnect. Keeps retrying forever; never dies after one failure. */
  private retryLater(): void {
    if (this.retryTimer) return; // a retry is already scheduled
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.startWatcher().catch((err: Error) => {
        this.logger.error(`reconnect failed, retrying in 5s: ${err.message}`);
        this.retryLater();
      });
    }, 5000);
    this.retryTimer.unref();
  }

  private async handleEvent(evt: DockerEvent): Promise<void> {
    const serverId =
      evt.Actor && evt.Actor.Attributes && evt.Actor.Attributes[LABEL];
    if (!serverId) return;
    const [server] = await this.dbService.db
      .select()
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    if (!server) return;

    if (evt.status === 'start') {
      await this.dbService.db
        .update(servers)
        .set({ status: 'starting', lastStartedAt: sql`(datetime('now'))` })
        .where(eq(servers.id, serverId));
      return;
    }
    if (evt.status === 'health_status: healthy') {
      await this.dbService.db
        .update(servers)
        .set({ status: 'running' })
        .where(eq(servers.id, serverId));
      return;
    }
    if (evt.status === 'oom') {
      this.eventsService.recordEvent({
        serverId,
        type: 'oom',
        summary:
          'Container hit its memory limit (OOM). Raise the container memory limit or lower the Java heap.',
      });
      return;
    }
    if (evt.status !== 'die') return;

    const exitCode = Number(evt.Actor?.Attributes?.exitCode ?? -1);
    const [stopRequested] = await this.dbService.db
      .select({ x: sql<number>`1` })
      .from(eventsTable)
      .where(
        and(
          eq(eventsTable.serverId, serverId),
          inArray(eventsTable.type, [
            'stop-requested',
            'restart-requested',
            'kill-requested',
          ]),
          gt(eventsTable.createdAt, sql`datetime('now', '-3 minutes')`),
        ),
      )
      .limit(1);
    // Clean exits are judged by the exit code, not just the request window:
    // 0 = normal, 143 = SIGTERM (docker stop), 130 = SIGINT — all intentional.
    const cleanExit = exitCode === 0 || exitCode === 143 || exitCode === 130;
    // 137 = SIGKILL. A graceful `docker stop` escalates SIGTERM→SIGKILL
    // after its grace period, so a slow-saving world that misses the
    // deadline exits 137 during an intended stop. If a stop/restart was
    // requested, treat it as intentional.
    const killedBySignal = exitCode === 137;

    if (cleanExit || (killedBySignal && stopRequested)) {
      await this.dbService.db
        .update(servers)
        .set({ status: 'stopped' })
        .where(eq(servers.id, serverId));
      if (!stopRequested) {
        this.eventsService.recordEvent({
          serverId,
          type: 'stopped',
          summary: `Server stopped (exit code ${exitCode})`,
        });
      }
      return;
    }

    // Crash path — even inside a stop/restart window a non-zero, non-signal
    // exit is a crash and must be recorded as one.
    await this.dbService.db
      .update(servers)
      .set({ status: 'crashed' })
      .where(eq(servers.id, serverId));
    const excerpt: string = await this.logs
      .fetchLogs(serverId, { tail: 300 })
      .catch(() => '');

    // Config errors never fix themselves — diagnose them so the crash event
    // says WHAT to do, and skip auto-restarts that would just burn cycles.
    const diagnosis = this.diagnoseFatal(excerpt);
    this.eventsService.recordEvent({
      serverId,
      type: 'crashed',
      summary: diagnosis
        ? `Server crashed: ${diagnosis.summary}`
        : `Server crashed (exit code ${exitCode})${stopRequested ? ' while a stop/restart was in progress' : ''}`,
      details: {
        exitCode,
        duringStopWindow: Boolean(stopRequested),
        diagnosis: diagnosis ? diagnosis.key : null,
      },
      logExcerpt: excerpt || null,
    });
    if (diagnosis) return; // auto-restart cannot help a config error

    // A crash during a requested stop/restart must not fight the panel's
    // own lifecycle handling with an auto-restart.
    if (stopRequested) return;
    // SIGKILL with no stop request is typically an external kill /
    // OOM-adjacent event — recorded above, but don't fight it with an
    // auto-restart loop.
    if (killedBySignal) return;
    if (!server.autoRestart) return;
    const now = Date.now();
    const window = (this.crashWindows.get(serverId) || []).filter(
      (t) => now - t < CRASH_WINDOW_MS,
    );
    window.push(now);
    this.crashWindows.set(serverId, window);
    if (window.length > MAX_RAPID_CRASHES) {
      this.eventsService.recordEvent({
        serverId,
        type: 'crash-loop',
        summary: `Auto-restart suspended: ${window.length} crashes within 10 minutes`,
      });
      return;
    }
    const delayMs = 5000 * 2 ** (window.length - 1); // 5s, 10s, 20s
    setTimeout(() => {
      void (async () => {
        try {
          const info = await this.containers.inspectStatus(serverId);
          if (info.exists && info.status === 'crashed') {
            // TODO(ServersModule): go through the guarded lifecycle
            // (ServersService.startServer), not ContainerService.startContainer
            // directly, so this can't race a user start/recreate/delete and so
            // pending config changes (pendingRecreate) are honored rather than
            // starting a stale container. Wire via forwardRef() once
            // ServersModule exists — see this file's class doc comment.
            this.logger.warn(
              `auto-restart for ${serverId} skipped: ServersModule not wired yet (TODO — see DockerWatcherService doc comment)`,
            );
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(`auto-restart failed: ${message}`);
        }
      })();
    }, delayMs).unref();
  }

  /** Match known unrecoverable startup errors → actionable message. */
  private diagnoseFatal(logText: string): FatalDiagnosis | null {
    if (!logText) return null;
    const KNOWN: FatalDiagnosis[] = [
      {
        key: 'cf-api-key',
        re: /API key is not set.*CF_API_KEY/is,
        summary:
          'CurseForge API key missing in the container — add your key in Settings → API keys, then Recreate this server.',
      },
      {
        key: 'eula',
        re: /You need to agree to the EULA/i,
        summary:
          'The Minecraft EULA was not accepted — recreate the server from the panel (it sets EULA automatically).',
      },
      {
        key: 'java-version',
        re: /UnsupportedClassVersionError/i,
        summary:
          'Wrong Java version for this Minecraft build — set the Java image override in Settings (or clear it to auto) and Recreate.',
      },
      {
        key: 'world-downgrade',
        re: /No key dimensions in MapLike|loading a newer world|created by a newer version/i,
        summary:
          'The world was created on a newer Minecraft version than this server runs — reset or swap the world (Worlds tab), or raise the MC version.',
      },
      {
        key: 'port-bind',
        re: /Failed to bind to port|Address already in use/i,
        summary:
          'The game port is already in use on this machine — change the port in Settings and Recreate.',
      },
      {
        key: 'oom',
        re: /OutOfMemoryError/i,
        summary:
          'Java ran out of heap — raise RAM in Settings → Resources (packs usually need 4–8 GB) and Recreate.',
      },
    ];
    for (const k of KNOWN) if (k.re.test(logText)) return k;
    return null;
  }
}
