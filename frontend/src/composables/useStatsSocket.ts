import { ref, onUnmounted, type Ref } from 'vue';
import { io, type Socket } from 'socket.io-client';
import type { TpsReading } from '../../../shared/types/monitoring';

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
  /** Latest tick-rate reading; `null` once the server is known not to report one (vanilla). */
  tps: Ref<TpsReading | null>;
  /** True after the first `tps` message, so "not reported" can be told apart from "not yet probed". */
  tpsProbed: Ref<boolean>;
  connected: Ref<boolean>;
  error: Ref<string | null>;
  close: () => void;
}

export function useStatsSocket(serverId: string): StatsSocket {
  const sample = ref<StatsSample | null>(null);
  const tps = ref<TpsReading | null>(null);
  const tpsProbed = ref(false);
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

  socket.on('message', (msg: StatsSample | { kind: 'tps'; tps: TpsReading | null }) => {
    if (msg.kind === 'tps') {
      tps.value = msg.tps;
      tpsProbed.value = true;
    } else if (msg.kind === 'stats') sample.value = msg;
    else if (msg.kind === 'error') error.value = msg.message ?? 'Stats stream error.';
  });

  function close() {
    socket.disconnect();
  }
  onUnmounted(close);

  return { sample, tps, tpsProbed, connected, error, close };
}
