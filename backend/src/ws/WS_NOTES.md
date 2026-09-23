# WS gateway notes

Replaces the pre-rewrite app's raw-`ws` implementation with
`@nestjs/websockets`'s socket.io gateway pattern. This was a **deliberate
wire-protocol break** per the rewrite plan. The frontend's
`useConsoleSocket`/`useStatsSocket` composables (`frontend/src/composables/`)
now target these socket.io namespaces via `socket.io-client` — the migration
described below is complete end-to-end.

## New connection shape

- Namespaces: `/ws/console`, `/ws/stats`, `/ws/status` (one namespace each,
  not one per-server room — simpler than the legacy per-URL-segment routing,
  and socket.io's namespace model is the idiomatic fit).
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
- Status: `{kind:'status',status}`, `{kind:'container-replaced'}`.

Client → server, socket.io event name `'cmd'` (console only):
`{command: string}`.

## `/ws/status` — pushing lifecycle transitions to the frontend

Added because the server-detail page originally had no live-update path at
all: it fetched status once on mount and once after the viewing user's own
Start/Stop/Restart click, so a status change from another tab/user, a crash,
or the startup watchdog's `starting → stalled`/`stalled → running`
promotion (`ServerLifecycleService.refreshStatuses()`, `SERVERS_NOTES.md`'s
"startup watchdog" section) never reached an open detail page.

- **Source of truth for the push**: `StatusBusService`
  (`backend/src/status-bus/`), a plain `EventEmitter`-based in-process bus,
  not `@nestjs/event-emitter`/`EventEmitter2` — this codebase has no existing
  dependency on that package and a hand-rolled single-purpose emitter needed
  no new dependency. There are **two** emitters, and both are required —
  each owns status writes the other never makes:
  - `ServerLifecycleService` calls
    `statusBus.emitStatusChanged({serverId, status})` at every DB write that
    changes `servers.status` (`startServerImpl`, `stopServerImpl`,
    `killServer`, `recreateServerImpl`'s create-failure path,
    `refreshStatuses()`'s poll loop) — deliberately NOT on `createServer`'s
    initial `status: 'stopped'` insert (nothing is listening for a server
    that doesn't exist yet) or the soft-delete transaction (the frontend
    already navigates away on its own delete call, so nothing is left to
    update).
  - `DockerWatcherService` routes all four of its own status writes
    (`start`→`starting`, `health_status: healthy`→`running`, `die`→`stopped`,
    crash→`crashed`) through a private `setStatus()` helper that emits. It is
    the real-time source for exactly the transitions nothing else sees — a
    crash, and the healthcheck's promotion to `running` — and the 60s poll
    cannot cover for a missed emit there: `refreshStatuses()` only emits when
    its computed status _differs_ from the stored row, which the watcher has
    already overwritten, so a dropped emit is never recovered, just lost.
    This is why `DockerModule` imports `StatusBusModule` despite otherwise
    being a zero-import leaf (safe: `StatusBusModule` has no imports either).
- **`container-replaced`**: a second bus event, emitted by
  `recreateServerImpl` after a successful `createContainer`. Not a status
  transition (a plain stop/start reuses the container, and a recreate does
  not itself change `servers.status`), but it invalidates anything holding a
  handle on the old container — specifically the console gateway's log
  follower. Kept separate so the console tab can reconnect on a real
  container swap without reconnecting on every status change.
- **Why a bus, not direct injection**: `WsModule` already imports
  `ServersModule` one-way. Injecting a gateway straight into
  `ServerLifecycleService` would need `WsModule` importable from
  `ServersModule` too — a fresh circular module dependency needing
  `forwardRef()` on both sides, on top of the two `SchedulerModule`/`MapModule`
  cycles `SERVERS_NOTES.md` already documents. `StatusBusModule` is a small
  leaf both modules import instead — no cycle, no `forwardRef()`.
- **`StatusGateway`** (`backend/src/ws/status.gateway.ts`) holds no
  Docker-facing stream of its own — `handleConnection` just registers
  `statusBus.onStatusChanged()`/`onContainerReplaced()` listeners filtered to
  the connection's `serverId` and forwards matching events as
  `{kind:'status',status}` / `{kind:'container-replaced'}`;
  `handleDisconnect` unregisters them. Same auth/permission/origin checks as
  the other two gateways via `authenticateGatewayConnection()`. Its
  per-socket state (and the `state.closed` check after the auth `await`,
  mirroring `ConsoleGateway`) is load-bearing, not bookkeeping: these
  listeners live on a process-wide emitter, so a client that disconnects
  during the auth await — whose `handleDisconnect` therefore runs _before_
  the listener would be registered — must not end up subscribing, or every
  cancelled connect leaks a listener for the lifetime of the process.
- **Frontend**: `useStatusSocket.ts` is opened once by
  `ServerDetailLayout.vue` — for the whole page's lifetime, not a single tab
  — so it catches a status change no matter which tab is active. On a
  message it re-fetches the server over HTTP (updates the header/status chip
  and anything status-gated like `MetricsTab`'s `v-if`) and bumps
  `statusVersion` / `containerVersion` refs provided alongside
  `server`/`refresh` via `useServerDetail()`. The composable exposes its own
  `version` counter and the layout watches **that**, not `status`: two pushes
  carrying the same string (restart a server that is already `starting`) are
  a real change, and a watcher on the value alone silently swallows the
  second one.
- **Console re-tail**: the console socket's log follower is bound to one
  container via `DockerLogsService.followLogs()` at connect time and does not
  resume on its own, so `ConsoleTab.vue` reconnects — but `reconnect()` wipes
  the rendered lines and re-tails only the last 300, so it fires **only when
  the existing stream is really dead**: on a `containerVersion` bump (a
  recreate removed that container), or on a `statusVersion` bump while
  `socket.ended` is true (a stop ended the stream, so there is a new run to
  tail). A status change on a live stream — `starting` → `running` arriving
  mid-boot from the watchdog — deliberately does nothing, or it would wipe
  the boot output the user is reading. Unlike
  `useConsoleSocket`/`useStatsSocket`, `useStatusSocket` does not register
  its own `onUnmounted(close)` — it gets recreated on `serverId` change, not
  once per component, so `ServerDetailLayout.vue` owns closing it explicitly.

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

## Per-server permission check

`authenticateGatewayConnection()` also checks `PermissionsService.can(user, serverId, 'view')`
after the session/server-existence checks below, disconnecting the same way
(`client.disconnect(true)`, no payload) on a server the caller may not view — the WS counterpart of
`ServerPermissionGuard`'s HTTP 404. `ConsoleGateway`'s `cmd` handler separately checks the
`console` capability (replacing a hardcoded `['admin', 'operator']` role check) before running any
command, since an operator's role default can still be narrowed per-server. See
`backend/src/permissions/PERMISSIONS_NOTES.md` for the full design.

## Handshake origin check

`authenticateGatewayConnection()` (`gateway-auth.ts`) now also validates the
handshake's `Origin` (falling back to `Referer`) against the handshake's own
`Host` header before doing anything else, disconnecting on a mismatch —
the WS counterpart of the HTTP `OriginGuard`
(`backend/src/auth/guards/origin.guard.ts`; see `AUTH_NOTES.md` for the
full CSRF defense-in-depth reasoning shared by both).

This is **not** redundant with `SameSite` on the session cookie: the
browser `WebSocket` API is exempt from same-origin policy — a page on any
origin can call `new WebSocket(...)` against this panel and, absent an
explicit check, the browser will still attach the `msm.sid` cookie to the
handshake under `SameSite=Lax`/`None` (lax allows the cross-site GET the
WS upgrade rides on). Nothing else in this codebase was checking the
handshake's `Origin` — `@WebSocketGateway()` here has no `cors` option
configured, and socket.io does not apply an origin check unless one is
configured, so the handshake was previously unguarded. Same rule as
`OriginGuard`: under `COOKIE_SAMESITE=none`, a handshake carrying neither
`Origin` nor `Referer` is rejected too (see `AUTH_NOTES.md`), since the
cookie alone provides no CSRF protection in that mode.

No new `ALLOWED_ORIGINS`-style config was added — same reasoning as
`AUTH_NOTES.md`'s "why no ALLOWED_ORIGINS config" section: the panel is
single-origin (no CORS setup exists anywhere in `backend/`), so the check
is a same-origin host match against the handshake's own `Host`, not a
configured allowlist.

## `main.ts` requires an explicit socket.io adapter

`NestFactory.create()`'s default WS adapter is `@nestjs/websockets`'
bare `WsAdapter` (raw `ws`, not socket.io) — installing
`@nestjs/platform-socket.io` does NOT change this automatically.
`app.useWebSocketAdapter(new IoAdapter(app))` must be called explicitly
before `app.listen()` for `@WebSocketGateway()` to actually bind via
socket.io.
