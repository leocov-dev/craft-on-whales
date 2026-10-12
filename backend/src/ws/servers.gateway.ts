import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import type { PublicUser } from '../auth/auth.service';
import { SessionService } from '../auth/session.service';
import { ConfigService } from '../config/config.service';
import { PermissionsService } from '../permissions/permissions.service';
import {
  StatusBusService,
  type ServerListChangedEvent,
  type ServerStatusChangedEvent,
} from '../status-bus/status-bus.service';
import { authenticateGatewaySession } from './gateway-auth';

interface ServersSocketState {
  closed: boolean;
  onStatus: ((event: ServerStatusChangedEvent) => void) | null;
  onListChanged: ((event: ServerListChangedEvent) => void) | null;
}

/**
 * `/ws/servers` — fleet-wide counterpart of `/ws/status` for the server list.
 * Pushes `{kind:'status', serverId, status}` for every status transition and
 * `{kind:'list-changed', serverId, change}` when a server is created or
 * deleted (the client refetches over HTTP, which is already permission
 * filtered). Every event is checked against the user's `view` permission
 * before it is forwarded, so a server hidden from them never leaks its
 * status. See WS_NOTES.md.
 */
@WebSocketGateway({ namespace: '/ws/servers' })
export class ServersGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(ServersGateway.name);
  private readonly state = new WeakMap<Socket, ServersSocketState>();

  constructor(
    private readonly config: ConfigService,
    private readonly sessions: SessionService,
    private readonly permissions: PermissionsService,
    private readonly statusBus: StatusBusService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    // Registered before the auth await so a disconnect mid-setup can't leave
    // a listener on the process-wide bus (same reasoning as StatusGateway).
    const state: ServersSocketState = {
      closed: false,
      onStatus: null,
      onListChanged: null,
    };
    this.state.set(client, state);

    client.on('error', (err: Error) => {
      this.logger.warn(`servers socket error: ${err.message}`);
      this.cleanup(client);
    });

    const user = await authenticateGatewaySession(
      this.config,
      this.sessions,
      client,
    );
    if (!user) return;
    if (state.closed) return; // client disconnected during the await

    state.onStatus = (event) => {
      void this.forwardIfVisible(client, user, event.serverId, {
        kind: 'status',
        serverId: event.serverId,
        status: event.status,
      });
    };
    state.onListChanged = (event) => {
      void this.forwardIfVisible(client, user, event.serverId, {
        kind: 'list-changed',
        serverId: event.serverId,
        change: event.change,
      });
    };
    this.statusBus.onStatusChanged(state.onStatus);
    this.statusBus.onServerListChanged(state.onListChanged);
  }

  handleDisconnect(client: Socket): void {
    this.cleanup(client);
  }

  private async forwardIfVisible(
    client: Socket,
    user: PublicUser,
    serverId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      if (!(await this.permissions.can(user, serverId, 'view'))) return;
      if (client.connected) client.emit('message', payload);
    } catch (err) {
      this.logger.warn(
        `servers socket forward failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private cleanup(client: Socket): void {
    const state = this.state.get(client);
    if (!state) return;
    state.closed = true;
    if (state.onStatus) {
      this.statusBus.offStatusChanged(state.onStatus);
      state.onStatus = null;
    }
    if (state.onListChanged) {
      this.statusBus.offServerListChanged(state.onListChanged);
      state.onListChanged = null;
    }
  }
}
