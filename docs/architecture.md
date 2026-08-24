# Architecture

Minecraft Server Manager is rewritten as two independent packages — a **NestJS** backend
(`backend/`) and a **Vue 3 + Quasar** frontend (`frontend/`) — replacing the original single-process
Express + Handlebars app. It manages Minecraft servers that run as Docker containers using the
[itzg/docker-minecraft-server](https://github.com/itzg/docker-minecraft-server) image, talking to the
Docker daemon over its API (never by shelling out to the `docker` CLI).

> The pre-rewrite implementation (`src/`, `views/`) still exists at the repo root as a reference
> until final cutover — see [AGENTS.md](../AGENTS.md) for the current state of that transition. This
> document describes the new `backend/`/`frontend/` architecture.

## Runtime shape

- **NestJS** (`backend/`) serves a pure JSON API plus WebSocket gateways — no server-rendered views.
  Dependency injection replaces the old flat CommonJS modules and their lazy `require()`
  cycle-breakers: every service is an `@Injectable()` class, wired through constructor injection and
  grouped into `@Module()`s along domain lines.
- **Vue 3 + Quasar** (`frontend/`) is the SPA that consumes that API — built with Quasar CLI
  (`@quasar/app-vite`), styled with theme-driven Quasar SCSS variables rather than ad hoc utility
  classes.
- **Drizzle ORM** over **`node:sqlite`** (flagless, built into Node ≥ 24) is the database — a
  TS-first, SQL-like query builder replacing hand-written SQL strings, still zero native modules,
  still WAL mode. `drizzle-kit` generates versioned SQL migrations from the schema in
  `backend/src/db/schema/*.ts`; `backend/src/db/migrate.ts` applies them at boot.
- **socket.io** (via `@nestjs/websockets`/`@nestjs/platform-socket.io`) carries the live console and
  stats streams, replacing the original raw-`ws` implementation. See
  [`backend/src/ws/WS_NOTES.md`](../backend/src/ws/WS_NOTES.md) for the wire-format details.
- **dockerode** is still the only way the app talks to Docker. The endpoint is auto-detected per
  platform (Windows named pipe vs. unix socket).
- **All persistent state lives under one directory** (`$DATA_DIR`, default `./data`). Copying that
  directory migrates the entire panel — unchanged from before the rewrite.

## Layering

Dependencies flow in one direction, same rule as before, now expressed as Nest modules instead of
flat files:

```
                 ┌─────────────────────────────┐
   HTTP  ───────▶│      controllers/*.ts        │   parse & validate input (zod), shape responses
                 └──────────────┬──────────────┘
                                │
                 ┌──────────────▼──────────────┐
                 │         *.service.ts         │   domain logic — the actual features
                 └───┬─────────┬─────────┬─────┘
                     │         │         │
        ┌────────────▼──┐ ┌────▼────┐ ┌──▼──────────┐
        │   docker/*    │ │  db/*   │ │  storage/*  │   infrastructure
        └───────────────┘ └─────────┘ └─────────────┘
```

- **Controllers** — one (or a few) per domain module, e.g. `ServersController`,
  `PlayersController`. Parse/validate with zod (manual `z.object(...)` schemas, no separate DTO
  classes — see `backend/src/auth/auth.controller.ts` for the established pattern), call an injected
  service, return a plain object shaped to match the API's established JSON contract. No business
  logic here.
- **Services** — the heart of the app, one `@Injectable()` class per concern. A module that outgrew
  a single responsibility gets split further (e.g. `ServersModule`'s hub service became
  `ServerLifecycleService` / `ServerEnvironmentService` / `ServerPreviewService` / `ServerQueryService`
  / `ServerLocksService` — see [`backend/src/servers/SERVERS_NOTES.md`](../backend/src/servers/SERVERS_NOTES.md)).
- **`docker/`** — dockerode wrappers, one service per concern: `DockerConnectionService` (endpoint
  detection + daemon health, never throws on a down daemon), `ContainerService`,
  `DockerLogsService`, `DockerStatsService`, `DockerImagesService`, `DockerNetworksService`,
  `HostPathService`, `McRouterDockerService`, and `DockerWatcherService` (turns Docker events into
  history + crash detection; starts on `onModuleInit`).
- **`db/`** — `DbService` wraps the Drizzle-over-`node:sqlite` connection (opened synchronously in
  the constructor, not `onModuleInit` — see the "boot sequence" note below for why) and exposes the
  Drizzle query builder (`db.select()/insert()/update()/delete()`) to injected consumers.
- **`storage/`** — `PathGuardService` (the `safeJoin` file-safety backbone, unchanged in spirit),
  `DataRootService` (the `./data` bootstrap), `StorageIndexService` (background size-indexer +
  quota enforcement).

Cross-cutting, global modules:

- **`ConfigModule`** (`@Global()`) — `ConfigService` resolves environment config synchronously in
  its constructor (host, port, resource defaults, session secret, etc.).
- **`EventsModule`** (`@Global()`) — `EventsService.recordEvent(...)` is still the one entry point
  for the history log; a true cross-cutting leaf with no back-edges into any domain module.
- **`AuthModule`** — `AuthService`, `TotpService`, `SecretsService` (AES-256-GCM keyed from
  `scrypt(SESSION_SECRET)`), `SessionService` (used by **both** HTTP and the WS gateways — the
  session-cookie verification that used to be duplicated between Express middleware and the raw-`ws`
  layer now has exactly one implementation). Registers three **global guards** via `APP_GUARD`:
  `SessionAuthGuard` (every route requires a session unless marked `@Public()`), `OriginGuard` (CSRF
  check on state-changing requests), `WriteGuard` (viewer role is read-only by default, with an
  `@AllowViewerWrite()` escape hatch for self-service routes like 2FA management). `RolesGuard` +
  `@Roles(...)` is applied per-route for admin/operator-gated endpoints.

## Circular module dependencies (`forwardRef()`)

`ServersModule` is the hub nearly everything else depends on, but a handful of modules have a
genuine _bidirectional_ relationship with it — Nest's `forwardRef()` is used for exactly these
cases, each with an inline comment citing the specific cycle:

- **`ServersModule` ↔ `SchedulerModule`** — deleting a server needs to disarm its live cron jobs;
  the scheduler needs `ServerLifecycleService` to actually run a scheduled restart/backup/stop.
- **`ServersModule` ↔ `MapModule`** — a server's extra Docker ports include BlueMap's allocated
  port; BlueMap's config needs to know which world is active.
- **`WorldsModule` ↔ `MapModule`** — switching the active world needs to resync BlueMap's config;
  BlueMap needs `WorldPropsService` to read which world is active.
- **`InventoryModule` ↔ `PlayersModule`** — inventory editing needs the online-player roster;
  player-facing roster/teleport features read inventory data.
- A cascading case: once `UpdatesModule` (needed by `SchedulerModule` for scheduled update checks)
  pulled in `ModsModule`/`PacksModule`, both of _those_ needed their own `ServersModule` import
  wrapped in `forwardRef()` too, since they now sat transitively on the same require cycle.

Where a plain circular `import` would crash at file-load time (not just at Nest's DI-resolution
time), the affected service uses `import type` for the type reference plus a lazily-`require()`'d
runtime value inside `@Inject(forwardRef(() => require('...').ClassName))` — see
`backend/src/servers/server-lifecycle.service.ts`'s `SchedulerService` injection for the
established pattern. Every one of these cases traces back to a require-cycle audit of the original
`src/services/servers.ts` (documented in `SERVERS_NOTES.md`) — only two cycles were genuine there;
the rest of the module graph's `forwardRef()`s appeared as later modules were layered on top.

## Key domain behaviors

Unchanged by the rewrite — these are product behaviors, not implementation details:

- **Modpacks are always pinned.** The image auto-upgrades unpinned packs on every restart, so the
  panel resolves "latest" to a concrete version id at install time and pins it. Upgrades are an
  explicit orchestrated flow (`UpdatesModule`): preview → pre-update backup → graceful stop → re-pin
  → recreate → health-monitor → one-click rollback.
- **The custom-mod overlay** is panel-managed: user-added mods land in the deduplicated library and
  are hard-linked into the server so they survive pack updates. Disabling is class-aware.
- **Ports** are allocated from a base scheme (game from `PORT_GAME_START` upward, RCON = game +
  `PORT_RCON_OFFSET`, Bedrock from `PORT_BEDROCK_START`), probed for availability, and reserved in
  the DB (`PortsService`).
- **Disk quotas** are enforced by the panel because Docker can't cap bind-mount usage:
  `StorageIndexService` caches per-directory sizes and disk-growing operations are gated on them.
- **Secrets** (RCON passwords, API keys) are encrypted at rest with AES-256-GCM using a key derived
  from `SESSION_SECRET` (`SecretsService`). Blueprints strip all secrets on export.

## Data & wire formats

- **`data/panel.db`** — the SQLite database, now with an explicit Drizzle-generated schema
  (`backend/src/db/schema/*.ts`, one file per domain table group) instead of implicit
  hand-written migrations.
- **`data/.session-secret`** — the auto-generated panel secret, created on first run if
  `SESSION_SECRET` is unset. Deleting it rotates the secret (which invalidates sessions and stored
  encrypted secrets).
- **Blueprints (`.mcserver.zip`)** — unchanged format: a zip with a `manifest.json` describing
  config, resources, the pinned pack reference, the overlay manifest (source URLs + sha256), chosen
  config files, and optionally a world.
- **Docker containers** created by the panel are named and labelled so `DockerWatcherService` can
  find them; the panel owns their full lifecycle.
- **WebSocket messages** — socket.io, not raw `ws`. Two namespaces, `/ws/console` and `/ws/stats`,
  each still carrying the same JSON payload shapes as before (`{kind: 'log'|'stats'|'cmd'|...}`).
  See `backend/src/ws/WS_NOTES.md` for the exact schema and the backpressure mechanism (byte-buffer
  thresholds ported unchanged: pause at 1MB outbound, resume under 200KB).

## Boot sequence

`backend/src/main.ts`, in order — the ordering itself is load-bearing, not incidental:

1. Create the Nest app; install the socket.io WS adapter (`app.useWebSocketAdapter(new IoAdapter(app))`
   — Nest's default WS adapter speaks raw `ws`, not socket.io, so this must be set explicitly).
2. Register the `express-session` middleware — **before** `app.init()` deliberately, since `init()`
   is what mounts Nest's router onto the underlying Express app; anything registered after it would
   run after route dispatch, so guards and controllers would see an empty `req.session`.
3. `DataRootService.ensureDataRoot()` — create the `./data` layout, wipe `tmp/`.
4. Run Drizzle migrations — explicitly, from `main.ts`, not from the DI graph.
5. `app.init()` — this is what fires every module's `onModuleInit` hooks (`SchedulerModule` arms
   cron jobs by querying the `schedules` table here, for example) — migrations must already be
   applied by this point, or a module with DB-touching boot logic queries a table that doesn't
   exist yet. `DbService`'s connection is opened as a plain constructor side effect (not
   `onModuleInit`) specifically so it's ready earlier than this, right after the DI graph resolves.
6. `app.listen()` — Docker connectivity is never awaited anywhere in this sequence:
   `DockerConnectionService`/`DockerWatcherService` initialize independently and fail soft, so the
   UI is fully usable while the daemon is down; Docker features light up when it becomes reachable.

See [`backend/src/db/DRIZZLE_NOTES.md`](../backend/src/db/DRIZZLE_NOTES.md) for the specific
`NestFactory.create()`-vs-`app.init()` lifecycle-hook gotcha that shaped this ordering.
