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
import { PermissionsService } from '../permissions/permissions.service';
import {
  StatusBusService,
  type ContainerReplacedEvent,
  type ServerStatusChangedEvent,
} from '../status-bus/status-bus.service';
import { authenticateGatewayConnection } from './gateway-auth';

interface StatusSocketState {
  closed: boolean;
  onStatus: ((event: ServerStatusChangedEvent) => void) | null;
  onContainerReplaced: ((event: ContainerReplacedEvent) => void) | null;
}

/**
 * `/ws/status` — pushes `{kind:'status', status}` whenever a server's cached
 * status changes, from either emitter: ServerLifecycleService (start/stop/
 * kill/the 60s poll's stalled/running transitions) or DockerWatcherService
 * (the daemon's own start/healthy/die/crash events). Also pushes
 * `{kind:'container-replaced'}` when a recreate swaps the container out, so
 * the console tab knows its log follower is bound to one that no longer
 * exists. Unlike `/ws/console` and `/ws/stats`, this carries no
 * per-connection stream of its own — it's a thin forward of StatusBusService,
 * scoped to the connection's `serverId` — so the frontend can keep one
 * connection open for the whole server-detail page (not just the active tab)
 * and react to changes it didn't itself cause. See WS_NOTES.md.
 */
@WebSocketGateway({ namespace: '/ws/status' })
export class StatusGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(StatusGateway.name);
  private readonly state = new WeakMap<Socket, StatusSocketState>();

  constructor(
    private readonly config: ConfigService,
    private readonly sessions: SessionService,
    private readonly serverQuery: ServerQueryService,
    private readonly permissions: PermissionsService,
    private readonly statusBus: StatusBusService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    // Registered synchronously, before the auth await below: a disconnect
    // mid-setup runs cleanup() first, and `closed` is what tells the code
    // after the await not to subscribe to a process-wide emitter nothing
    // will ever unsubscribe from. Mirrors ConsoleGateway's `state.closed`.
    const state: StatusSocketState = {
      closed: false,
      onStatus: null,
      onContainerReplaced: null,
    };
    this.state.set(client, state);

    client.on('error', (err: Error) => {
      this.logger.warn(`status socket error: ${err.message}`);
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
    if (state.closed) return; // client disconnected during the await

    state.onStatus = (event: ServerStatusChangedEvent) => {
      if (event.serverId !== serverId) return;
      if (client.connected)
        client.emit('message', { kind: 'status', status: event.status });
    };
    state.onContainerReplaced = (event: ContainerReplacedEvent) => {
      if (event.serverId !== serverId) return;
      if (client.connected)
        client.emit('message', { kind: 'container-replaced' });
    };
    this.statusBus.onStatusChanged(state.onStatus);
    this.statusBus.onContainerReplaced(state.onContainerReplaced);
  }

  handleDisconnect(client: Socket): void {
    this.cleanup(client);
  }

  private cleanup(client: Socket): void {
    const state = this.state.get(client);
    if (!state) return;
    state.closed = true;
    if (state.onStatus) {
      this.statusBus.offStatusChanged(state.onStatus);
      state.onStatus = null;
    }
    if (state.onContainerReplaced) {
      this.statusBus.offContainerReplaced(state.onContainerReplaced);
      state.onContainerReplaced = null;
    }
  }
}
