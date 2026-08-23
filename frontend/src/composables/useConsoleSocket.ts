import { ref, onUnmounted, type Ref } from 'vue';
import { io, type Socket } from 'socket.io-client';

// socket.io client for the /ws/console namespace (backend/src/ws/console.gateway.ts).
// Protocol: one 'message' event carrying JSON {kind: 'log'|'log-end'|'cmd-result'|'error', ...}
// down, 'cmd' event carrying {command} up. See backend/src/ws/WS_NOTES.md for the full spec.
// See useStatsSocket.ts's header comment — this file is deliberately isolated so a future
// wire-protocol change only touches these two composables.

export interface ConsoleLine {
  text: string;
  level: 'INFO' | 'WARN' | 'ERROR';
}

export interface CmdResult {
  command: string;
  output: string;
  error?: string;
}

export interface ConsoleSocket {
  lines: Ref<ConsoleLine[]>;
  connected: Ref<boolean>;
  ended: Ref<boolean>;
  lastResult: Ref<CmdResult | null>;
  sendCommand: (command: string) => void;
  close: () => void;
}

type WireMessage =
  | { kind: 'log'; text: string }
  | { kind: 'log-end' }
  | { kind: 'error'; message: string }
  | { kind: 'cmd-result'; command: string; output: string; error?: string };

function levelOf(text: string): ConsoleLine['level'] {
  if (/\/(ERROR|FATAL)\]/.test(text)) return 'ERROR';
  if (/\/WARN\]/.test(text)) return 'WARN';
  return 'INFO';
}

const MAX_LINES = 2000;

export function useConsoleSocket(serverId: string): ConsoleSocket {
  const lines = ref<ConsoleLine[]>([]);
  const connected = ref(false);
  const ended = ref(false);
  const lastResult = ref<CmdResult | null>(null);

  // No explicit `transports` override: leave socket.io's default
  // polling->websocket upgrade path intact so the initial handshake (which
  // carries the msm.sid session cookie the backend authenticates with) isn't
  // skipped. `withCredentials: true` is required for the browser to attach
  // that cookie at all, same-origin or not.
  const socket: Socket = io('/ws/console', {
    query: { serverId },
    withCredentials: true,
    // socket.io-client auto-reconnects by default; legacy's raw-ws client
    // never did (a drop just left `connected` false forever). Neither
    // current call site (ConsoleTab.vue) reads `connected` today, so there's
    // no existing "reconnecting" UI state to preserve or conflict with —
    // auto-reconnect is a strict improvement here, not a behavior change
    // anything currently depends on.
  });

  socket.on('connect', () => {
    connected.value = true;
  });
  socket.on('disconnect', () => {
    connected.value = false;
  });

  socket.on('message', (msg: WireMessage) => {
    if (msg.kind === 'log') {
      const newLines = msg.text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((text) => ({ text, level: levelOf(text) }));
      lines.value.push(...newLines);
      if (lines.value.length > MAX_LINES) lines.value.splice(0, lines.value.length - MAX_LINES);
    } else if (msg.kind === 'log-end') {
      ended.value = true;
    } else if (msg.kind === 'cmd-result') {
      lastResult.value = {
        command: msg.command,
        output: msg.output,
        ...(msg.error ? { error: msg.error } : {}),
      };
    } else if (msg.kind === 'error') {
      lastResult.value = { command: '', output: '', error: msg.message ?? 'Console error.' };
    }
  });

  function sendCommand(command: string) {
    if (socket.connected) socket.emit('cmd', { command });
  }

  function close() {
    socket.disconnect();
  }
  onUnmounted(close);

  return { lines, connected, ended, lastResult, sendCommand, close };
}
