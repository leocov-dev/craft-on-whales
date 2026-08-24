# Servers module port notes

`src/services/servers.ts` (985 lines, the plan's "hub" service) was split
per SOLID into:

- `ServerQueryService` — read-only `listServers`/`getServer`/`mustGet` +
  row→`Server` mapping. Not named explicitly in the plan, but factored out
  (judgment call) because `ServerLifecycleService`, `ServerEnvironmentService`,
  and `ServerPreviewService` all need identical row-reading logic.
- `ServerEnvironmentService` — `assembleEnv`, `resolveImage`, `mergeExtraPorts`,
  `panelUidGid`, `ensureOwnership`, `setConsoleLabel`. Judgment call:
  `ensureOwnership`/`setConsoleLabel` live here (not `ServerLifecycleService`)
  since both are about a server's _configured state_ (files, label), not a
  lifecycle transition or a preview.
- `ServerPreviewService` — `previewCreateSpec`/`previewServerSpec`. Kept
  separate from `ServerEnvironmentService` despite being thin: it's a
  distinct read-only/dry-run concern.
- `ServerLocksService` — the plan's explicit naming. Wraps both legacy
  concurrency primitives verbatim: the create-serialization chain
  (`runSerializedCreate`) and the per-server lifecycle mutex (`guard`,
  ported from `guardOp`, including the "piggyback on an in-flight start"
  behavior).
- `ServerLifecycleService` — create/start/stop/restart/kill/recreate/delete/
  updateServer/refreshStatuses/dirSize. Judgment call: `updateServer` lives
  here rather than a separate service, since diffing config + flagging
  `pendingRecreate` is lifecycle-adjacent.
- `PortsService`, `DockerSpecService`, `JavaMatrixService` — per the plan's
  explicit naming, all one-directional dependencies of the hub (no cycle).
- `ApiKeysService` (`backend/src/api-keys/`) and `SettingsService`
  (`backend/src/settings/`) — built as their own small modules per the
  require-cycle audit below (both are clean leaves, no reason to bury them
  inside `servers/`).
- `PathGuardService` (`backend/src/storage/path-guard.service.ts`) — only
  the containment-guard primitive (`safeJoin`/`dataPath`/`isInsideDataDir`)
  needed by `ServersModule` today. The rest of legacy `src/storage/`
  (indexer, quotas, `dataRoot`) is `StorageModule`'s job, built later.

## Require-cycle audit (the plan's "Highest-risk task")

Traced every `require()` in `servers.ts` and cross-checked every file that
requires `servers.ts` back.

**Genuine bidirectional cycles found: exactly two.**

1. **`servers ↔ scheduler`** (`servers.ts:851`, explicitly commented "lazy —
   avoids a require cycle"; `scheduler.ts:46` requires servers back).
   `SchedulerModule` doesn't exist yet. Resolved without `forwardRef()`:
   the only thing `deleteServer` needs from scheduler is to disarm each
   server's live cron job — but no cron jobs run anywhere in this rewrite
   yet (nothing schedules them, since `SchedulerModule` doesn't exist), so
   there is nothing live to disarm today. The `schedules` DB rows still get
   cleaned up in `deleteServer`'s transaction (this is a soft-delete, so FK
   cascade never fires) — only the "disarm the live cron" call is a
   `// TODO(SchedulerModule)` in `server-lifecycle.service.ts`'s
   `deleteServer` doc comment, to be wired via `forwardRef()` once
   `SchedulerModule` exists.
2. **`servers ↔ map`** (`servers.ts:190`'s `mergeExtraPorts`, lazy; `map.ts:17`
   requires servers back for `getServer`). `MapModule` doesn't exist yet.
   `ServerEnvironmentService.mergeExtraPorts()` has a
   `// TODO(MapModule)` — BlueMap's extra port is never merged in until
   `MapModule` is built and wired via `forwardRef()`. Safe degrade: without
   `MapModule` there's also no way yet to configure a BlueMap integration
   row in the first place, so this never silently drops a real port today.

**Checked, not a cycle**: `servers.ts` also lazily requires `./apiKeys`
(`getKey('curseforge')`, 2 call sites) — `apiKeys.ts` only requires `../db`,
`../config`, `./secrets`, `../events`, no dependency on servers at all.
Built as a real, non-deferred `ApiKeysService` constructor-injected into
`ServerEnvironmentService`/`ServerLifecycleService`.

**Checked, self-contained, no cycle**: `./javaMatrix` (zero requires),
`./ports` (zero requires beyond `../db`/`../config`), `./dockerSpec`
(requires only `./ports` + `../docker/networks`), `./settings` (requires
only `../db`) — all built as real dependencies, no `forwardRef()` needed for
any of them.

## Everything else ported 1:1

`createServer`/`updateServer`/`deleteServer`/lifecycle methods keep their
external call shape from the legacy functions (per the plan's "keep
signatures unchanged" guidance) — only the internal data-access calls moved
from raw SQL strings to the Drizzle query builder, since that's the one
place the plan says signatures don't need to survive unchanged.

`httpError(status, msg)` calls were replaced with Nest's built-in
`HttpException` subclasses (`BadRequestException`, `ConflictException`,
`NotFoundException`, `PreconditionFailedException`) — matching the
convention already established in `AuthModule`, not the legacy custom
helper.
