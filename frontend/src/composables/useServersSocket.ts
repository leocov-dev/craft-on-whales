import { io, type Socket } from 'socket.io-client';

// socket.io client for the /ws/servers namespace (backend/src/ws/servers.gateway.ts):
// fleet-wide status pushes for the server list. Protocol: one 'message' event
// carrying {kind:'status', serverId, status} or {kind:'list-changed', serverId,
// change}. See useStatusSocket.ts / WS_NOTES.md. Not component-scoped — the
// servers store owns the single connection for the whole signed-in session.

export interface ServersSocketHandlers {
  onStatus: (serverId: string, status: string) => void;
  /** A server was created or deleted. */
  onListChanged: (serverId: string, change: 'created' | 'deleted') => void;
  /** Fires on every (re)connect: events pushed while disconnected were lost, so resync. */
  onConnect: () => void;
}

type WireMessage =
  | { kind: 'status'; serverId: string; status: string }
  | { kind: 'list-changed'; serverId: string; change: 'created' | 'deleted' };

export function useServersSocket(handlers: ServersSocketHandlers): { close: () => void } {
  const socket: Socket = io('/ws/servers', { withCredentials: true });

  socket.on('connect', handlers.onConnect);
  socket.on('message', (msg: WireMessage) => {
    if (msg.kind === 'status') handlers.onStatus(msg.serverId, msg.status);
    else if (msg.kind === 'list-changed') handlers.onListChanged(msg.serverId, msg.change);
  });

  return { close: () => socket.disconnect() };
}
