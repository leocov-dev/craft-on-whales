# WS gateway notes

Replaces legacy `src/ws/index.ts`'s raw-`ws` implementation with
`@nestjs/websockets`'s socket.io gateway pattern. This is a **deliberate
wire-protocol break** per the rewrite plan — the Phase 1 Vue frontend's
`useConsoleSocket`/`useStatsSocket` composables still target the OLD raw-`ws`
endpoints (`/ws/console/:id`, `/ws/stats/:id`) and need a follow-up rewrite to
`socket.io-client` before this is wired up end-to-end. That frontend work is
explicitly out of scope here.

## New connection shape

- Namespaces: `/ws/console`, `/ws/stats` (one namespace each, not one
  per-server room — simpler than the legacy per-URL-segment routing, and
  socket.io's namespace model is the idiomatic fit).
- Server selection: connect with `io('/ws/console', { query: { serverId } })`
  — read from `client.handshake.query.serverId` server-side. (An alternative
  would be joining a room after connect via a `join` event; query-param
  selection was chosen to keep parity with legacy's one-socket-per-server
  model and because auth + server-existence checks both need to happen
  before any log-following starts, i.e. at `handleConnection` time.)
- Auth: `SessionService.authenticateFromCookieHeader(client.handshake.headers.cookie)`
  — the same shared cookie-verification logic the HTTP `SessionAuthGuard`
  uses, per the plan's explicit goal of unifying HTTP+WS session checks.
  `client.handshake.headers.cookie` requires the browser to actually send
  the `msm.sid` cookie on the WS handshake — socket.io does this
  automatically for same-origin connections with `withCredentials: true`.
- Server-not-found and no-session both `client.disconnect(true)` immediately
  — no structured error payload on the wire for these (matches legacy's
  behavior of just refusing the upgrade with a raw HTTP status/close code
  before any application-level messages could flow).

## Message shapes (unchanged from legacy, still JSON payloads)

Server → client, emitted as socket.io event name `'message'` (kept as one
event name carrying a `kind` discriminator, matching legacy's single-channel
JSON-blob design, rather than mapping each `kind` to its own socket.io event
— minimizes churn for the eventual frontend rewrite since the payload shapes
are byte-identical to today's raw-`ws` messages):

- Console: `{kind:'log',text}`, `{kind:'log-end'}`, `{kind:'error',message}`,
  `{kind:'cmd-result',command,output,error?}`.
- Stats: `{kind:'stats',...NormalizedStats}`, `{kind:'error',message}`.

Client → server, socket.io event name `'cmd'` (console only):
`{command: string}`.

## Backpressure

Ported exactly: pause the docker log stream when the socket's outbound
buffer exceeds 1,000,000 bytes, resume under 200,000, polled every 100ms via
an `.unref()`'d interval. Socket.io's `Socket` has no public byte-buffer
accessor equivalent to raw `ws`'s `bufferedAmount` — the underlying `ws`
`WebSocket` instance (which DOES have `.bufferedAmount`) is reached via
`client.conn.transport.socket` once the connection has upgraded to the
websocket transport. Verified against `engine.io`'s own compiled source
(`node_modules/engine.io/build/transports/websocket.js`): the `WebSocket`
Transport class does `this.socket = req.websocket` — a TS-`private`-but
JS-plain field (not a real `#private`), so it's genuinely readable at
runtime despite the `.d.ts` marking it private. Guarded by checking
`transport.name === 'websocket'` first; connections still on the
long-polling transport skip backpressure entirely (matches legacy, which
never had a polling fallback in the first place — it only ever spoke raw
websocket).

## `main.ts` requires an explicit socket.io adapter

`NestFactory.create()`'s default WS adapter is `@nestjs/websockets`'
bare `WsAdapter` (raw `ws`, not socket.io) — installing
`@nestjs/platform-socket.io` does NOT change this automatically.
`app.useWebSocketAdapter(new IoAdapter(app))` must be called explicitly
before `app.listen()` for `@WebSocketGateway()` to actually bind via
socket.io.
