import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { SessionService } from '../auth/session.service';
import { ConfigService } from '../config/config.service';
import { ServerQueryService } from '../servers/server-query.service';
import { DockerStatsService } from '../docker/docker-stats.service';
import { authenticateGatewayConnection } from './gateway-auth';
import { PermissionsService } from '../permissions/permissions.service';
import { TpsService } from '../monitoring/tps.service';

/** How often each open stats socket asks for a TPS reading (cached 5s). */
const TPS_INTERVAL_MS = 10_000;

/**
 * `/ws/stats` — replaces legacy `src/ws/index.ts`'s `/ws/stats/:serverId`
 * raw-`ws` handler. One periodic sample per tick, `{ kind: 'stats', ... }`.
 */
@WebSocketGateway({ namespace: '/ws/stats' })
export class StatsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(StatsGateway.name);
  private readonly stoppers = new WeakMap<
    Socket,
    {
      stop: (() => void) | null;
      closed: boolean;
      tpsTimer: NodeJS.Timeout | null;
    }
  >();

  constructor(
    private readonly config: ConfigService,
    private readonly sessions: SessionService,
    private readonly serverQuery: ServerQueryService,
    private readonly stats: DockerStatsService,
    private readonly permissions: PermissionsService,
    private readonly tps: TpsService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    // Synchronous error handler before any await, matching legacy's care
    // that a socket error never becomes an unhandled crash.
    client.on('error', (err: Error) => {
      this.logger.warn(`stats socket error: ${err.message}`);
      this.cleanup(client);
    });

    const auth = await authenticateGatewayConnection(
      this.config,
      this.sessions,
      this.serverQuery,
      this.permissions,
      client,
    );
    if (!auth) return;
    const { serverId } = auth;

    const entry = {
      stop: null as (() => void) | null,
      closed: false,
      tpsTimer: null as NodeJS.Timeout | null,
    };
    this.stoppers.set(client, entry);

    try {
      const stop = await this.stats.statsStream(serverId, (sample) => {
        if (client.connected)
          client.emit('message', { kind: 'stats', ...sample });
      });
      entry.stop = stop;
      if (entry.closed)
        stop(); // client left during the await
      else this.startTps(client, serverId, entry);
    } catch (err) {
      if (client.connected) {
        client.emit('message', {
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  handleDisconnect(client: Socket): void {
    this.cleanup(client);
  }

  /** `{ kind: 'tps', tps: null }` means the server has no TPS command (vanilla). */
  private startTps(
    client: Socket,
    serverId: string,
    entry: { closed: boolean; tpsTimer: NodeJS.Timeout | null },
  ): void {
    const tick = async (): Promise<void> => {
      const sample = await this.tps.probe(serverId);
      if (!entry.closed && client.connected) {
        client.emit('message', { kind: 'tps', tps: sample });
      }
    };
    void tick();
    entry.tpsTimer = setInterval(() => void tick(), TPS_INTERVAL_MS);
  }

  private cleanup(client: Socket): void {
    const entry = this.stoppers.get(client);
    if (!entry || entry.closed) return;
    entry.closed = true;
    if (entry.tpsTimer) clearInterval(entry.tpsTimer);
    entry.stop?.();
  }
}
