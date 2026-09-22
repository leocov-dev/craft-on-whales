import type { Socket } from 'socket.io';
import { authenticateGatewayConnection } from './gateway-auth';
import type { SessionService } from '../auth/session.service';
import type { ServerQueryService } from '../servers/server-query.service';
import type { ConfigService, CookieSameSite } from '../config/config.service';
import type { PublicUser } from '../auth/auth.service';
import type { PermissionsService } from '../permissions/permissions.service';

function permissionsAllowing(canView: boolean): PermissionsService {
  return {
    can: jest.fn().mockResolvedValue(canView),
  } as unknown as PermissionsService;
}

function configWith(sameSite: CookieSameSite): ConfigService {
  return { cookieSameSite: sameSite } as unknown as ConfigService;
}

function socketWith(headers: Record<string, string | undefined>): {
  client: Socket;
  disconnect: jest.Mock;
} {
  const disconnect = jest.fn();
  const client = {
    handshake: { headers, query: { serverId: 'srv1' } },
    disconnect,
  } as unknown as Socket;
  return { client, disconnect };
}

const user = { id: 'u1', username: 'admin', role: 'admin' } as PublicUser;

function sessionsReturning(u: PublicUser | null): SessionService {
  return {
    authenticateFromCookieHeader: jest.fn().mockResolvedValue(u),
  } as unknown as SessionService;
}

function serverQueryReturning(exists: boolean): ServerQueryService {
  return {
    getServer: jest.fn().mockResolvedValue(exists ? { id: 'srv1' } : null),
  } as unknown as ServerQueryService;
}

describe('authenticateGatewayConnection — handshake origin check', () => {
  it('disconnects and rejects a cross-origin handshake', async () => {
    const { client, disconnect } = socketWith({
      origin: 'https://evil.example',
      host: 'panel.local',
      cookie: 'msm.sid=s:whatever',
    });
    const result = await authenticateGatewayConnection(
      configWith('lax'),
      sessionsReturning(user),
      serverQueryReturning(true),
      permissionsAllowing(true),
      client,
    );
    expect(result).toBeNull();
    expect(disconnect).toHaveBeenCalledWith(true);
  });

  it('accepts a same-origin handshake and proceeds to session auth', async () => {
    const { client, disconnect } = socketWith({
      origin: 'https://panel.local',
      host: 'panel.local',
      cookie: 'msm.sid=s:whatever',
    });
    const result = await authenticateGatewayConnection(
      configWith('lax'),
      sessionsReturning(user),
      serverQueryReturning(true),
      permissionsAllowing(true),
      client,
    );
    expect(result).toEqual({ user, serverId: 'srv1' });
    expect(disconnect).not.toHaveBeenCalled();
  });

  it.each(['lax', 'strict'] as const)(
    'allows a %s-mode handshake with neither Origin nor Referer',
    async (sameSite) => {
      const { client } = socketWith({ host: 'panel.local' });
      const result = await authenticateGatewayConnection(
        configWith(sameSite),
        sessionsReturning(user),
        serverQueryReturning(true),
        permissionsAllowing(true),
        client,
      );
      expect(result).toEqual({ user, serverId: 'srv1' });
    },
  );

  it('rejects a none-mode handshake with neither Origin nor Referer', async () => {
    const { client, disconnect } = socketWith({ host: 'panel.local' });
    const result = await authenticateGatewayConnection(
      configWith('none'),
      sessionsReturning(user),
      serverQueryReturning(true),
      permissionsAllowing(true),
      client,
    );
    expect(result).toBeNull();
    expect(disconnect).toHaveBeenCalledWith(true);
  });
});
