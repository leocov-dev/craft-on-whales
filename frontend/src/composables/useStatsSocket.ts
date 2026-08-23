import { ref, onUnmounted, type Ref } from 'vue';
import { io, type Socket } from 'socket.io-client';

// socket.io client for the /ws/stats namespace (backend/src/ws/stats.gateway.ts).
// See useConsoleSocket.ts's header comment — deliberately isolated so a future
// wire-protocol change only touches these two composables. Full spec:
// backend/src/ws/WS_NOTES.md.

export interface StatsSample {
  kind: 'stats' | 'error';
  cpuPct?: number;
  memUsedBytes?: number;
  memLimitBytes?: number;
  netRx?: number;
  netTx?: number;
  message?: string;
}

export interface StatsSocket {
  sample: Ref<StatsSample | null>;
  connected: Ref<boolean>;
  error: Ref<string | null>;
  close: () => void;
}

export function useStatsSocket(serverId: string): StatsSocket {
  const sample = ref<StatsSample | null>(null);
  const connected = ref(false);
  const error = ref<string | null>(null);

  // See useConsoleSocket.ts for why `withCredentials` and the default
  // transports (no forced `['websocket']`) matter for cookie-based auth, and
  // why leaving socket.io-client's default auto-reconnect enabled is safe
  // here (MetricsTab.vue doesn't read `connected` today either).
  const socket: Socket = io('/ws/stats', {
    query: { serverId },
    withCredentials: true,
  });

  socket.on('connect', () => {
    connected.value = true;
  });
  socket.on('disconnect', () => {
    connected.value = false;
  });
  socket.on('connect_error', () => {
    error.value = 'Connection error.';
  });

  socket.on('message', (msg: StatsSample) => {
    if (msg.kind === 'stats') sample.value = msg;
    else if (msg.kind === 'error') error.value = msg.message ?? 'Stats stream error.';
  });

  function close() {
    socket.disconnect();
  }
  onUnmounted(close);

  return { sample, connected, error, close };
}
