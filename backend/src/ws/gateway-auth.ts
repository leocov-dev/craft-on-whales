import type { Socket } from 'socket.io';
import { SessionService } from '../auth/session.service';
import { ServerQueryService } from '../servers/server-query.service';
import type { PublicUser } from '../auth/auth.service';

/**
 * Shared `handleConnection` auth: authenticates the socket's session cookie
 * and validates the `serverId` handshake query param, disconnecting the
 * client on either failure — the boilerplate every `/ws/*` gateway repeats
 * before starting its own stream.
 */
export async function authenticateGatewayConnection(
  sessions: SessionService,
  serverQuery: ServerQueryService,
  client: Socket,
): Promise<{ user: PublicUser; serverId: string } | null> {
  const user = await sessions.authenticateFromCookieHeader(
    client.handshake.headers.cookie,
  );
  if (!user) {
    client.disconnect(true);
    return null;
  }
  const serverId = String(client.handshake.query.serverId || '');
  if (!serverId || !(await serverQuery.getServer(serverId))) {
    client.disconnect(true);
    return null;
  }
  return { user, serverId };
}
