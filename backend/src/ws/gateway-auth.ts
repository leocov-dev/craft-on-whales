import type { Socket } from 'socket.io';
import { SessionService } from '../auth/session.service';
import { ServerQueryService } from '../servers/server-query.service';
import type { PublicUser } from '../auth/auth.service';
import type { ConfigService } from '../config/config.service';

/**
 * WS-handshake counterpart of `OriginGuard` (`backend/src/auth/guards/origin.guard.ts`)
 * — see `WS_NOTES.md` for why this can't just be socket.io's own `cors`
 * option. Same host-match rule as the HTTP guard: unlike `fetch`/XHR, the
 * browser `WebSocket` API is exempt from same-origin policy, so a page on
 * any origin can otherwise open a socket and ride the browser's cookie jar.
 */
function hasValidOrigin(config: ConfigService, client: Socket): boolean {
  const { origin, referer, host } = client.handshake.headers;
  const rawOrigin = origin || referer || null;
  if (!rawOrigin) return config.cookieSameSite !== 'none';
  try {
    return new URL(rawOrigin).host === host;
  } catch {
    return false;
  }
}

/**
 * Shared `handleConnection` auth: validates the handshake's Origin/Referer,
 * authenticates the socket's session cookie, and validates the `serverId`
 * handshake query param — disconnecting the client on any failure. The
 * boilerplate every `/ws/*` gateway repeats before starting its own stream.
 */
export async function authenticateGatewayConnection(
  config: ConfigService,
  sessions: SessionService,
  serverQuery: ServerQueryService,
  client: Socket,
): Promise<{ user: PublicUser; serverId: string } | null> {
  if (!hasValidOrigin(config, client)) {
    client.disconnect(true);
    return null;
  }
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
