'use strict';

// WebSocket endpoints:
//   /ws/console/<serverId>  — live log stream down, RCON commands up
//   /ws/stats/<serverId>    — normalized stats samples every 2s
// Messages are JSON: {kind: 'log'|'stats'|'cmd'|'cmd-result'|'error', ...}

import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type WebSocket from 'ws';

const { WebSocketServer } = require('ws') as typeof import('ws');
const signature = require('cookie-signature') as typeof import('cookie-signature');
const config = require('../config') as typeof import('../config');
const db = require('../db') as typeof import('../db');
const { followLogs } = require('../docker/logs') as typeof import('../docker/logs');
const { statsStream } = require('../docker/stats') as typeof import('../docker/stats');
const { execCapture, inspectStatus } = require('../docker/containers') as typeof import('../docker/containers');
const { getServer } = require('../services/servers') as typeof import('../services/servers');
const { recordEvent } = require('../events') as typeof import('../events');
const auth = require('../services/auth') as typeof import('../services/auth');

type SessionUser = NonNullable<ReturnType<typeof auth.getUser>>;

function attachWebSockets(httpServer: HttpServer) {
  // maxPayload caps inbound frame size so a client can't buffer huge frames in
  // memory before our handlers run (commands are trimmed to 500 chars anyway).
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  wss.on('error', (err) => console.warn('[ws] server error:', err.message));

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = /^\/ws\/(console|stats)\/([a-zA-Z0-9_-]+)$/.exec((req.url || '').split('?')[0] || '');
    if (!match) {
      socket.destroy();
      return;
    }
    const user = sessionUser(req);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const [, kind, serverId] = match as unknown as [string, string, string];
      if (!getServer(serverId)) {
        ws.close(4404, 'unknown server');
        return;
      }
      if (kind === 'console') handleConsole(ws, serverId, user);
      else handleStats(ws, serverId);
    });
  });

  return wss;
}

async function handleConsole(ws: WebSocket, serverId: string, user: SessionUser): Promise<void> {
  const send = (obj: Record<string, unknown>): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };
  let follower: Awaited<ReturnType<typeof followLogs>> | null = null;
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (follower) follower.stop();
  };
  // Attach lifecycle listeners SYNCHRONOUSLY, before the await below. This does two
  // critical things: (1) an 'error' listener means a socket protocol error can never
  // become an unhandled 'error' event that crashes the whole process; (2) a client
  // that disconnects during followLogs() still triggers cleanup once the stream exists.
  ws.on('error', (err) => {
    console.warn('[ws] console socket error:', err.message);
    cleanup();
  });
  ws.on('close', cleanup);

  ws.on('message', async (raw: Buffer) => {
    let msg: { kind?: string; command?: string };
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (msg.kind !== 'cmd' || typeof msg.command !== 'string') return;
    // Viewers may watch logs but never execute commands.
    if (!['admin', 'operator'].includes(user.role)) {
      send({ kind: 'cmd-result', command: msg.command, output: '', error: 'Your role (viewer) cannot run commands.' });
      return;
    }
    const command = msg.command.trim().replace(/^\//, '').slice(0, 500);
    if (!command) return;
    try {
      const info = await inspectStatus(serverId);
      if (!info.exists || !['running', 'starting', 'unhealthy'].includes(info.status)) {
        send({ kind: 'cmd-result', command, output: '', error: 'Server is not running.' });
        return;
      }
      const raw = await execCapture(serverId, ['rcon-cli', '--', ...command.split(/\s+/)]);
      const output = (require('../utils/ansi') as typeof import('../utils/ansi')).stripAnsi(raw);
      send({ kind: 'cmd-result', command, output: output.trim() });
      // Optional in-game attribution: the vanilla "Rcon" sender can't be renamed,
      // so if this server has a console label we announce the action ourselves.
      announceConsoleAction(serverId, command);
      recordEvent({
        serverId,
        actor: user.username,
        type: 'rcon',
        summary: `RCON: ${redact(command)}`,
        details: { output: output.trim().slice(0, 2000) },
      });
    } catch (err) {
      send({ kind: 'cmd-result', command, output: '', error: err instanceof Error ? err.message : String(err) });
    }
  });

  try {
    const active = await followLogs(serverId, { tail: 300 });
    follower = active;
    if (closed) {
      active.stop();
      return;
    } // client already disconnected during the await
    active.stream.on('data', (chunk: Buffer) => {
      send({ kind: 'log', text: chunk.toString('utf8') });
      // Backpressure: if a chatty server outpaces a slow/backgrounded client, pause
      // the docker log stream until the socket's send buffer drains, so RSS can't grow
      // without bound.
      if (ws.bufferedAmount > 1_000_000 && !active.stream.isPaused()) {
        active.stream.pause();
        const tick = setInterval(() => {
          if (closed || ws.readyState !== ws.OPEN) {
            clearInterval(tick);
            return;
          }
          if (ws.bufferedAmount < 200_000) {
            clearInterval(tick);
            active.stream.resume();
          }
        }, 100);
        tick.unref?.();
      }
    });
    active.stream.on('end', () => send({ kind: 'log-end' }));
    active.stream.on('error', (err: Error) => send({ kind: 'error', message: `Log stream error: ${err.message}` }));
  } catch (err) {
    // A missing container (404) just means the server has never been started —
    // an expected state, not an error. The console already shows a "start the
    // server" placeholder, so end the stream quietly instead of alarming the user.
    if ((err as { statusCode?: number }).statusCode === 404) {
      send({ kind: 'log-end' });
    } else {
      send({ kind: 'error', message: `Log stream unavailable: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
}

async function handleStats(ws: WebSocket, serverId: string): Promise<void> {
  let stop: (() => void) | null = null;
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (stop) stop();
  };
  // Synchronous 'error'/'close' listeners: no unhandled 'error' crash, and a
  // disconnect during the statsStream() await still tears the stream down.
  ws.on('error', (err: Error) => {
    console.warn('[ws] stats socket error:', err.message);
    cleanup();
  });
  ws.on('close', cleanup);
  try {
    stop = await statsStream(serverId, (sample) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ kind: 'stats', ...sample }));
    });
    if (closed && stop) stop(); // client left during the await
  } catch (err) {
    if (ws.readyState === ws.OPEN)
      ws.send(JSON.stringify({ kind: 'error', message: err instanceof Error ? err.message : String(err) }));
  }
}

/** Authenticate a WS upgrade from the express-session cookie → {id, username, role} | null. */
function sessionUser(req: IncomingMessage): SessionUser | null {
  try {
    const cookies = Object.fromEntries(
      (req.headers.cookie || '').split(';').map((c) => {
        const idx = c.indexOf('=');
        return [c.slice(0, idx).trim(), decodeURIComponent(c.slice(idx + 1))];
      })
    );
    const raw = cookies['msm.sid'];
    if (!raw || !raw.startsWith('s:')) return null;
    const sid = signature.unsign(raw.slice(2), config.sessionSecret);
    if (!sid) return null;
    const row = db.get('SELECT data_json, expires_at FROM sessions WHERE sid = ?', sid);
    if (!row || Date.parse(String(row.expires_at)) < Date.now()) return null;
    const data: { userId?: string } = JSON.parse(String(row.data_json));
    if (!data.userId) return null;
    return auth.getUser(data.userId);
  } catch {
    return null;
  }
}

/** Redact sensitive args (op passwords don't exist, but be safe with obvious keys). */
function redact(command: string): string {
  return command.replace(/(password|token|key)\s+\S+/gi, '$1 ●●●');
}

/**
 * If the server has a console label configured, announce the just-run command in
 * game chat as "[label] <command>" via tellraw (JSON-escaped, so nothing the admin
 * types can break out). Fire-and-forget — never blocks the command result.
 */
function announceConsoleAction(serverId: string, command: string): void {
  const label = getServer(serverId)?.console_label;
  if (!label) return;
  const payload = {
    text: '',
    extra: [
      { text: `[${label}] `, color: 'aqua', bold: true },
      { text: command, color: 'gray' },
    ],
  };
  execCapture(serverId, ['rcon-cli', '--', 'tellraw', '@a', JSON.stringify(payload)]).catch(() => {});
}

export = { attachWebSockets };
