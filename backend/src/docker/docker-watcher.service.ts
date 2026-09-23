import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { servers, events as eventsTable } from '../db/schema';
import { EventsService } from '../events/events.service';
import { DockerConnectionService } from './docker-connection.service';
import { ContainerService, LABEL } from './container.service';
import { DockerLogsService } from './docker-logs.service';
import { StatusBusService } from '../status-bus/status-bus.service';

const MAX_RAPID_CRASHES = 3;
const CRASH_WINDOW_MS = 10 * 60 * 1000;
// A single docker-events line is a small JSON object (well under 1KB in
// practice). Cap the line-reassembly buffer so a daemon that never sends
// the newline delimiter for an event (corrupt stream, or a burst with no
// backpressure) can't grow this buffer without bound — see DOCKER_NOTES.md.
const EVENT_BUFFER_MAX_BYTES = 256 * 1024;
// Reconnect backoff: doubles each consecutive failure, capped, so a
// prolonged daemon outage doesn't tight-loop reconnect attempts.
const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 5 * 60 * 1000;

export interface DockerEvent {
  status?: string;
  Action?: string;
  action?: string;
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
 * A crashed server is restarted via the guarded server lifecycle
 * (`ServerLifecycleService.startServer`), not `ContainerService.startContainer`
 * directly, so a watcher-triggered restart can't race a user's own
 * start/recreate/delete and honors `pendingRecreate`. `DockerModule` is a
 * widely-imported leaf module with no imports of its own — rather than give
 * it a new module-level dependency on `ServersModule` (attempted, but that
 * broke DI resolution elsewhere in the graph since so many modules plainly
 * import `DockerModule`), the restart handler is wired the other direction:
 * `setAutoRestartHandler()` lets `ServerLifecycleService` (which already
 * depends on `DockerModule`, a one-directional edge) register itself here at
 * boot via `onModuleInit`, with no new circular module dependency at all.
 *
 * The one exception to "no imports of its own" is `StatusBusModule`, which
 * every status write here goes through (see `setStatus()`): it is a
 * zero-import leaf providing a single `EventEmitter`, so it cannot pull
 * anything else into `DockerModule`'s graph or form a cycle with it.
 */
@Injectable()
export class DockerWatcherService implements OnModuleInit {
  private readonly logger = new Logger(DockerWatcherService.name);
  // serverId → recent crash timestamps (for backoff)
  private readonly crashWindows = new Map<string, number[]>();
  private stream: NodeJS.ReadableStream | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private autoRestartHandler: ((serverId: string) => Promise<void>) | null =
    null;

  constructor(
    private readonly connection: DockerConnectionService,
    private readonly containers: ContainerService,
    private readonly logs: DockerLogsService,
    private readonly eventsService: EventsService,
    private readonly dbService: DbService,
    private readonly statusBus: StatusBusService,
  ) {}

  /**
   * Every status write in this file goes through here: the watcher is the
   * real-time status source, and a bare DB update would never reach an open
   * server-detail page. The 60s poll cannot cover for a missed emit either —
   * `ServerLifecycleService.refreshStatuses()` only emits when its computed
   * status differs from the stored row, which this write has already
   * overwritten. See backend/src/ws/WS_NOTES.md.
   */
  private async setStatus(
    serverId: string,
    status: string,
    extraColumns: Partial<typeof servers.$inferInsert> = {},
  ): Promise<void> {
    await this.dbService.db
      .update(servers)
      .set({ status, ...extraColumns })
      .where(eq(servers.id, serverId));
    this.statusBus.emitStatusChanged({ serverId, status });
  }

  /** Registers the guarded-lifecycle restart callback — see class doc comment. */
  setAutoRestartHandler(handler: (serverId: string) => Promise<void>): void {
    this.autoRestartHandler = handler;
  }

  onModuleInit(): void {
    this.startWatcher().catch((err: Error) => {
      this.logger.error(`initial connect failed: ${err.message}`);
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
    // A successful connect means the outage (if any) is over — reset the
    // backoff so the NEXT disconnect starts counting from zero again.
    this.reconnectAttempts = 0;
    let buffer = '';
    s.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > EVENT_BUFFER_MAX_BYTES) {
        this.logger.error(
          `docker events line buffer exceeded ${EVENT_BUFFER_MAX_BYTES} bytes without a newline — dropping buffered data`,
        );
        buffer = '';
      }
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

  /**
   * Schedule a reconnect. Keeps retrying forever; never dies after one
   * failure. Backoff doubles per consecutive failure (5s, 10s, 20s, ...),
   * capped at RECONNECT_MAX_MS, instead of a tight fixed-interval retry
   * loop against a daemon that's down for an extended outage.
   */
  private retryLater(): void {
    if (this.retryTimer) return; // a retry is already scheduled
    const delayMs = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempts,
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempts++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.startWatcher().catch((err: Error) => {
        this.logger.error(`reconnect failed: ${err.message}`);
        this.retryLater();
      });
    }, delayMs);
    this.retryTimer.unref();
  }

  /**
   * Docker reports an event's kind twice: the legacy `status` field and,
   * on newer daemons/API versions, `Action` (lowercase `action` over some
   * transports). Some daemons emit only the latter — a crashed JVM there
   * arrives as `Action: 'die'` with no `status` at all, which used to slip
   * past the die handler entirely, so the server was never marked crashed
   * and auto-restart never fired. Read whichever field is present.
   */
  private eventKind(evt: DockerEvent): string {
    return evt.status ?? evt.Action ?? evt.action ?? '';
  }

  /**
   * Handle one container event. Public so the spec can drive it directly;
   * the events stream is the only production caller.
   */
  async handleEvent(evt: DockerEvent): Promise<void> {
    const kind = this.eventKind(evt);
    const serverId =
      evt.Actor && evt.Actor.Attributes && evt.Actor.Attributes[LABEL];
    if (!serverId) return;
    const [server] = await this.dbService.db
      .select()
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    if (!server) return;

    if (kind === 'start') {
      await this.setStatus(serverId, 'starting', {
        lastStartedAt: new Date().toISOString(),
      });
      return;
    }
    if (kind === 'health_status: healthy') {
      await this.setStatus(serverId, 'running');
      return;
    }
    if (kind === 'oom') {
      this.eventsService.recordEvent({
        serverId,
        type: 'oom',
        summary:
          'Container hit its memory limit (OOM). Raise the container memory limit or lower the Java heap.',
      });
      return;
    }
    if (kind !== 'die') return;

    const exitCode = Number(evt.Actor?.Attributes?.exitCode ?? -1);
    const threeMinutesAgo = new Date(Date.now() - 3 * 60_000).toISOString();
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
          gt(eventsTable.createdAt, threeMinutesAgo),
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
      await this.setStatus(serverId, 'stopped');
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
    await this.setStatus(serverId, 'crashed');
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
            if (this.autoRestartHandler) {
              await this.autoRestartHandler(serverId);
            } else {
              this.logger.warn(
                `auto-restart for ${serverId} skipped: no handler registered`,
              );
            }
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(`auto-restart failed: ${message}`);
          this.eventsService.recordEvent({
            serverId,
            type: 'auto-restart-failed',
            summary: `Auto-restart attempt failed: ${message}`,
          });
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
