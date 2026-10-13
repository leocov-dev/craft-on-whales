import { ref, type Ref } from 'vue';
import { io, type Socket } from 'socket.io-client';
import type { ServerOperation } from '@/api/servers';

// socket.io client for the /ws/status namespace (backend/src/ws/status.gateway.ts).
// Protocol: one 'message' event carrying JSON {kind: 'status', status},
// {kind: 'container-replaced'} (a recreate swapped the container out) or
// {kind: 'operation', operation} (a restore/world install started, advanced or ended). See
// useConsoleSocket.ts's header comment — deliberately isolated so a future
// wire-protocol change only touches these composables. Full spec: WS_NOTES.md.
//
// Unlike the console/stats sockets, this one is meant to stay open for the
// whole server-detail page (opened by ServerDetailLayout.vue), not just a
// single tab, and gets recreated on demand (serverId change) rather than
// once per component — so, unlike the other two composables, it does NOT
// register its own onUnmounted(close); the caller owns its lifecycle and
// must call close() itself (ServerDetailLayout.vue does, both on unmount and
// before opening a replacement socket).

export interface StatusSocket {
  status: Ref<string | null>;
  /** Bumped on every status message. Watch this, not `status` — two pushes of
   *  the same value (e.g. `starting` → restart → `starting`) are a real change
   *  to react to, and a watcher on the value alone would swallow the second. */
  version: Ref<number>;
  /** Bumped when a recreate replaced the container, so anything holding a
   *  handle on the old one (the console tab's log follower) must reconnect. */
  containerVersion: Ref<number>;
  /** Latest operation push (null = finished); undefined until one arrives. */
  operation: Ref<ServerOperation | null | undefined>;
  connected: Ref<boolean>;
  close: () => void;
}

type WireMessage =
  | { kind: 'status'; status: string }
  | { kind: 'container-replaced' }
  | { kind: 'operation'; operation: ServerOperation | null };

export function useStatusSocket(serverId: string): StatusSocket {
  const status = ref<string | null>(null);
  const version = ref(0);
  const containerVersion = ref(0);
  const connected = ref(false);
  const operation = ref<ServerOperation | null | undefined>(undefined);

  const socket: Socket = io('/ws/status', {
    query: { serverId },
    withCredentials: true,
  });

  socket.on('connect', () => {
    connected.value = true;
  });
  socket.on('disconnect', () => {
    connected.value = false;
  });

  socket.on('message', (msg: WireMessage) => {
    if (msg.kind === 'status') {
      status.value = msg.status;
      version.value += 1;
    } else if (msg.kind === 'container-replaced') {
      containerVersion.value += 1;
    } else if (msg.kind === 'operation') {
      operation.value = msg.operation;
    }
  });

  function close() {
    socket.disconnect();
  }

  return { status, version, containerVersion, operation, connected, close };
}
