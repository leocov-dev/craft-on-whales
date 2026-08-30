# Docker module port notes

`src/docker/*.ts` (9 legacy files, ~1217 lines) was split per the plan's SOLID
guidance into one `@Injectable()` service per file, all in this directory:

- `DockerConnectionService` ← `connect.ts`
- `ContainerService` ← `containers.ts`
- `DockerLogsService` ← `logs.ts`
- `DockerStatsService` ← `stats.ts`
- `DockerImagesService` ← `images.ts`
- `DockerNetworksService` ← `networks.ts`
- `HostPathService` ← `hostPath.ts`
- `McRouterDockerService` ← `mcRouter.ts`
- `DockerWatcherService` ← `watcher.ts`

## Resolved: `DockerWatcherService` restarts via the guarded lifecycle

A crashed server is restarted via `ServerLifecycleService.startServer` — the
guarded lifecycle, not `ContainerService.startContainer` directly — so a
watcher-triggered restart can't race a user's own start/recreate/delete, and
honors `pendingRecreate` instead of starting a stale container.

`DockerModule` is a widely-imported leaf module with no imports of its own;
giving it a new module-level dependency on `ServersModule` was tried first
but broke DI resolution elsewhere in the graph (too many other modules
plainly import `DockerModule`). Instead, `DockerWatcherService` exposes
`setAutoRestartHandler()`, and `ServerLifecycleService` (which already
depends on `DockerModule`, a one-directional edge) registers itself via that
setter in its own `onModuleInit()` — no new circular module dependency.

## Other legacy require() sites worth flagging for the later cycle audit

- `containers.ts` requires `./hostPath` and `../db` at module scope (plain,
  no cycle) — ported directly to constructor injection (`HostPathService`,
  `DbService`).
- `watcher.ts` requires `./connect`, `./containers`, `./logs`, `../events`,
  `../db` at module scope (all plain, category-(b)) — all ported to
  constructor injection. Its ONE lazy, function-scoped require
  (`require('../services/servers')` inside the crash-restart `setTimeout`
  callback) is the sole category-(a) real-cycle site in this whole
  directory, and is the gap documented above.
- `mcRouter.ts` only requires `./connect` — no cycle risk, ported directly.
- None of the other 6 files (`connect.ts`, `hostPath.ts`, `images.ts`,
  `logs.ts`, `networks.ts`, `stats.ts`) have any require-cycle-relevant
  imports; all are either leaves or depend only on `connect.ts`/`containers.ts`.
