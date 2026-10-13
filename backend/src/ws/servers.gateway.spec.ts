import type { Socket } from 'socket.io';
import { ServersGateway } from './servers.gateway';
import { StatusBusService } from '../status-bus/status-bus.service';
import type { SessionService } from '../auth/session.service';
import type { ConfigService } from '../config/config.service';
import type { PermissionsService } from '../permissions/permissions.service';
import type { PublicUser } from '../auth/auth.service';

const user = { id: 'u1', username: 'bob', role: 'operator' } as PublicUser;

function setup(visible: Set<string>) {
  const bus = new StatusBusService();
  const gateway = new ServersGateway(
    { cookieSameSite: 'lax' } as unknown as ConfigService,
    {
      authenticateFromCookieHeader: jest.fn().mockResolvedValue(user),
    } as unknown as SessionService,
    {
      can: jest.fn((_u: unknown, id: string) =>
        Promise.resolve(visible.has(id)),
      ),
    } as unknown as PermissionsService,
    bus,
  );
  const emit = jest.fn();
  const client = {
    handshake: { headers: { host: 'panel.local' }, query: {} },
    connected: true,
    on: jest.fn(),
    emit,
    disconnect: jest.fn(),
  } as unknown as Socket;
  return { bus, gateway, client, emit };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('ServersGateway', () => {
  it('forwards status and list changes only for servers the user may view', async () => {
    const { bus, gateway, client, emit } = setup(new Set(['a']));
    await gateway.handleConnection(client);

    bus.emitStatusChanged({ serverId: 'a', status: 'running' });
    bus.emitStatusChanged({ serverId: 'hidden', status: 'running' });
    bus.emitServerListChanged({ serverId: 'hidden', change: 'created' });
    bus.emitServerListChanged({ serverId: 'a', change: 'deleted' });
    await flush();

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith('message', {
      kind: 'status',
      serverId: 'a',
      status: 'running',
    });
    expect(emit).toHaveBeenCalledWith('message', {
      kind: 'list-changed',
      serverId: 'a',
      change: 'deleted',
    });
  });

  it('unsubscribes from the bus on disconnect', async () => {
    const { bus, gateway, client } = setup(new Set(['a']));
    await gateway.handleConnection(client);
    expect(bus.listenerCount('status-changed')).toBe(1);
    gateway.handleDisconnect(client);
    expect(bus.listenerCount('status-changed')).toBe(0);
    expect(bus.listenerCount('server-list-changed')).toBe(0);
  });
});
