import { Logger } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway } from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { SessionService } from '../auth/session.service';
import { ServerQueryService } from '../servers/server-query.service';
import { DockerStatsService } from '../docker/docker-stats.service';

/**
 * `/ws/stats` — replaces legacy `src/ws/index.ts`'s `/ws/stats/:serverId`
 * raw-`ws` handler. One periodic sample per tick, `{ kind: 'stats', ... }`.
 */
@WebSocketGateway({ namespace: '/ws/stats' })
export class StatsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(StatsGateway.name);
  private readonly stoppers = new WeakMap<Socket, { stop: (() => void) | null; closed: boolean }>();

  constructor(
    private readonly sessions: SessionService,
    private readonly serverQuery: ServerQueryService,
    private readonly stats: DockerStatsService
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    // Synchronous error handler before any await, matching legacy's care
    // that a socket error never becomes an unhandled crash.
    client.on('error', (err: Error) => {
      this.logger.warn(`stats socket error: ${err.message}`);
      this.cleanup(client);
    });

    const user = await this.sessions.authenticateFromCookieHeader(client.handshake.headers.cookie);
    if (!user) {
      client.disconnect(true);
      return;
    }
    const serverId = String(client.handshake.query.serverId || '');
    if (!serverId || !(await this.serverQuery.getServer(serverId))) {
      client.disconnect(true);
      return;
    }

    const entry = { stop: null as (() => void) | null, closed: false };
    this.stoppers.set(client, entry);

    try {
      const stop = await this.stats.statsStream(serverId, (sample) => {
        if (client.connected) client.emit('message', { kind: 'stats', ...sample });
      });
      entry.stop = stop;
      if (entry.closed) stop(); // client left during the await
    } catch (err) {
      if (client.connected) {
        client.emit('message', { kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  handleDisconnect(client: Socket): void {
    this.cleanup(client);
  }

  private cleanup(client: Socket): void {
    const entry = this.stoppers.get(client);
    if (!entry || entry.closed) return;
    entry.closed = true;
    entry.stop?.();
  }
}
