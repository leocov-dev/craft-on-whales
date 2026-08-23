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

## Known gap: `DockerWatcherService` → `ServersService.startServer`

Legacy `watcher.ts` restarts a crashed server via
`require('../services/servers').startServer(serverId, { actor: 'watcher' })`
— the guarded lifecycle, not `ContainerService.startContainer` directly —
so a watcher-triggered restart can't race a user's own
start/recreate/delete, and honors `pending_recreate` instead of starting a
stale container.

`ServersModule` doesn't exist yet in this rewrite (it's next in the plan's
migration order, after `AuthModule`). `DockerWatcherService` is fully wired
otherwise — event stream connect/reconnect, status caching, crash
diagnosis, backoff bookkeeping — but the actual restart call is a
`// TODO(ServersModule)` that logs a warning instead of restarting.

**When `ServersModule` is built**: inject `ServersService` into
`DockerWatcherService` via `forwardRef()` (this is the one genuine
cross-module cycle the plan's require-cycle audit already flagged for this
exact edge — see the plan's "Highest-risk task" section) and replace the
TODO in `handleEvent()`'s crash-backoff branch with the real call.

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
