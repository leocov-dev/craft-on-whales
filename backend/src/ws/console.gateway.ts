import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { SessionService } from '../auth/session.service';
import { ServerQueryService } from '../servers/server-query.service';
import { ContainerService } from '../docker/container.service';
import {
  DockerLogsService,
  type FollowLogsResult,
} from '../docker/docker-logs.service';
import { EventsService } from '../events/events.service';
import { rcon } from '../utils/rcon';
import type { PublicUser } from '../auth/auth.service';
import { authenticateGatewayConnection } from './gateway-auth';

interface ConsoleSocketState {
  follower: FollowLogsResult | null;
  closed: boolean;
  user: PublicUser;
  serverId: string;
  lastCmdMs: number;
}

/**
 * `/ws/console` — replaces legacy `src/ws/index.ts`'s `/ws/console/:serverId`
 * raw-`ws` handler. Wire-protocol deliberately changed to socket.io per the
 * rewrite plan (see WS_NOTES.md); behavior — auth, RBAC, backpressure,
 * console-label announcement, event redaction — is a 1:1 port.
 */
@WebSocketGateway({ namespace: '/ws/console' })
export class ConsoleGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(ConsoleGateway.name);
  private readonly state = new WeakMap<Socket, ConsoleSocketState>();
  // Matches ChatCommandsRuntimeService's per-player spam guard.
  private static readonly CMD_THROTTLE_MS = 400;

  constructor(
    private readonly sessions: SessionService,
    private readonly serverQuery: ServerQueryService,
    private readonly containers: ContainerService,
    private readonly logs: DockerLogsService,
    private readonly events: EventsService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    // Attach error/close-equivalent handling synchronously, before any
    // await below — mirrors legacy's comment: a disconnect mid-setup must
    // still trigger cleanup, and a socket error must never go unhandled.
    client.on('error', (err: Error) => {
      this.logger.warn(`console socket error: ${err.message}`);
      this.cleanup(client);
    });

    const auth = await authenticateGatewayConnection(
      this.sessions,
      this.serverQuery,
      client,
    );
    if (!auth) return;
    const { user, serverId } = auth;

    const state: ConsoleSocketState = {
      follower: null,
      closed: false,
      user,
      serverId,
      lastCmdMs: 0,
    };
    this.state.set(client, state);

    try {
      const active = await this.logs.followLogs(serverId, { tail: 300 });
      state.follower = active;
      if (state.closed) {
        active.stop();
        return; // client already disconnected during the await
      }
      active.stream.on('data', (chunk: Buffer) => {
        this.send(client, { kind: 'log', text: chunk.toString('utf8') });
        this.maybeApplyBackpressure(client, active);
      });
      active.stream.on('end', () => this.send(client, { kind: 'log-end' }));
      active.stream.on('error', (err: Error) =>
        this.send(client, {
          kind: 'error',
          message: `Log stream error: ${err.message}`,
        }),
      );
    } catch (err: unknown) {
      // A missing container (404) just means the server has never been
      // started — expected, not an error; end the stream quietly.
      if ((err as { statusCode?: number }).statusCode === 404) {
        this.send(client, { kind: 'log-end' });
      } else {
        this.send(client, {
          kind: 'error',
          message: `Log stream unavailable: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  handleDisconnect(client: Socket): void {
    this.cleanup(client);
  }

  @SubscribeMessage('cmd')
  async handleCmd(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { command?: string },
  ): Promise<void> {
    const state = this.state.get(client);
    if (!state || typeof body?.command !== 'string') return;
    const { user, serverId } = state;

    // Viewers may watch logs but never execute commands.
    if (!['admin', 'operator'].includes(user.role)) {
      this.send(client, {
        kind: 'cmd-result',
        command: body.command,
        output: '',
        error: 'Your role (viewer) cannot run commands.',
      });
      return;
    }
    const command = body.command.trim().replace(/^\//, '').slice(0, 500);
    if (!command) return;

    const now = Date.now();
    if (now - state.lastCmdMs < ConsoleGateway.CMD_THROTTLE_MS) {
      this.send(client, {
        kind: 'cmd-result',
        command,
        output: '',
        error: 'Too many commands — slow down.',
      });
      return;
    }
    state.lastCmdMs = now;

    try {
      const info = await this.containers.inspectStatus(serverId);
      if (
        !info.exists ||
        !['running', 'starting', 'unhealthy'].includes(info.status)
      ) {
        this.send(client, {
          kind: 'cmd-result',
          command,
          output: '',
          error: 'Server is not running.',
        });
        return;
      }
      const output = await rcon(
        this.containers,
        serverId,
        command.split(/\s+/),
        { clean: 'ansi-only' },
      );
      this.send(client, { kind: 'cmd-result', command, output });
      this.announceConsoleAction(serverId, command).catch(() => {});
      this.events.recordEvent({
        serverId,
        actor: user.username,
        type: 'rcon',
        summary: `RCON: ${this.redact(command)}`,
        details: { output: this.redact(output.slice(0, 2000)) },
      });
    } catch (err) {
      this.send(client, {
        kind: 'cmd-result',
        command,
        output: '',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private cleanup(client: Socket): void {
    const state = this.state.get(client);
    if (!state || state.closed) return;
    state.closed = true;
    state.follower?.stop();
  }

  private send(client: Socket, payload: Record<string, unknown>): void {
    if (client.connected) client.emit('message', payload);
  }

  /**
   * Backpressure: pause the docker log stream once the socket's outbound
   * buffer exceeds 1MB, resume once it drops under 200KB — ports legacy's
   * raw-`ws` `bufferedAmount` check. Socket.io's `Socket` has no public
   * byte-buffer accessor; the underlying `ws` `WebSocket` instance (which
   * DOES expose `.bufferedAmount`, same as legacy used) is reachable via
   * `client.conn.transport.socket` once the connection has upgraded to the
   * websocket transport (verified against engine.io's own source: the
   * websocket Transport class assigns `this.socket = req.websocket` — a
   * plain, TS-`private`-but-JS-public field, not a real ECMAScript
   * `#private`). Polling-transport connections have no equivalent, so
   * backpressure is skipped for those (matches legacy's behavior, which
   * only ever ran over a raw websocket in the first place).
   */
  /** True once we've logged that `bufferedAmount` went missing — logged once, not per-tick. */
  private warnedMissingBufferedAmount = false;

  private maybeApplyBackpressure(
    client: Socket,
    active: FollowLogsResult,
  ): void {
    const transport = client.conn?.transport as
      { name?: string; socket?: { bufferedAmount?: number } } | undefined;
    if (transport?.name !== 'websocket') return;
    if (
      transport.socket?.bufferedAmount === undefined &&
      !this.warnedMissingBufferedAmount
    ) {
      this.warnedMissingBufferedAmount = true;
      this.logger.warn(
        'console backpressure: engine.io socket no longer exposes bufferedAmount — backpressure is silently disabled until this is fixed (likely a socket.io/engine.io upgrade)',
      );
    }
    const bufferedAmount = transport.socket?.bufferedAmount ?? 0;
    if (bufferedAmount > 1_000_000 && !active.stream.isPaused()) {
      active.stream.pause();
      const tick = setInterval(() => {
        const state = this.state.get(client);
        if (!state || state.closed || !client.connected) {
          clearInterval(tick);
          return;
        }
        const current =
          (
            client.conn?.transport as
              { socket?: { bufferedAmount?: number } } | undefined
          )?.socket?.bufferedAmount ?? 0;
        if (current < 200_000) {
          clearInterval(tick);
          active.stream.resume();
        }
      }, 100);
      tick.unref?.();
    }
  }

  /** Redact sensitive args before persisting the RCON event summary. */
  private redact(command: string): string {
    return command.replace(/(password|token|key)\s+\S+/gi, '$1 ●●');
  }

  /**
   * If the server has a console label configured, announce the just-run
   * command in game chat via tellraw. Fire-and-forget — never blocks the
   * command result.
   */
  private async announceConsoleAction(
    serverId: string,
    command: string,
  ): Promise<void> {
    const label = (await this.serverQuery.getServer(serverId))?.console_label;
    if (!label) return;
    const payload = {
      text: '',
      extra: [
        { text: `[${label}] `, color: 'aqua', bold: true },
        { text: command, color: 'gray' },
      ],
    };
    rcon(
      this.containers,
      serverId,
      ['tellraw', '@a', JSON.stringify(payload)],
      { clean: 'raw' },
    ).catch(() => {});
  }
}
