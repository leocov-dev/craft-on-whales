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

## server.properties has two owners, so it has one choke point

`ServerPropertiesService` is the only place that writes `server.properties`.
That is not tidiness — the file has a second writer the panel does not
control, in two different ways:

1. **The image re-applies env on every start.** `itzg/minecraft-server`
   rewrites every property it has a matching environment variable for each
   time the container boots. So a panel edit to PvP, difficulty, the
   whitelist or anything else env-backed was silently reverted on the next
   restart. `setProperty()` therefore writes the file _and_ deletes the
   matching key from `env_json` (flagging `pending_recreate`), which hands
   the file authority over that property for good. Values chosen in the
   wizard still apply at creation — the unlock only fires on a later edit.
   The property↔env mapping lives in `server-properties.map.ts`;
   `PANEL_OWNED_ENV` there is the set `assembleEnv()` owns outright and that
   an edit must never clear.

2. **Minecraft rewrites the file from its boot-time values.** Toggling the
   whitelist live (`/whitelist on`) makes the game write the whole file back
   out from what it loaded at startup, wiping a PvP or difficulty edit made
   minutes earlier. `preserveEdits()` snapshots the file, runs the command,
   waits for the game's rewrite, and restores every key of ours it clobbered
   except the one the command was meant to change.

The two deliberate exceptions go through `write()` (or `setProperty` with
`unlockEnv: false`): switching the active level sets `level-name` _and_
`LEVEL`, and a world reset sets `level-seed`/`level-type` _and_
`SEED`/`LEVEL_TYPE`. Clearing the env var there would undo the thing the
caller just set.

## Heap sizing and the idle-memory question

`JvmMemoryService` exists for two related reasons. Don't re-derive either.

**1. A bare number is bytes to Java.** The panel's own heap field is an
integer and `assembleEnv()` formats it as `` `${heap_mb}M` ``, so `MEMORY` was
never wrong. But `env_json` is free-form — the API's
`env: z.record(z.string(), z.string())`, blueprint manifests, pack-install
env — so a user (or an imported blueprint) can set `INIT_MEMORY=512`. The
itzg image passes that through verbatim and the JVM reads a suffix-less
`-Xms512` as 512 **bytes**: the server dies at boot with "Too small initial
heap". `assembleEnv()` therefore runs `normalizeSizeEnv()` over `MEMORY`,
`INIT_MEMORY` and `MAX_MEMORY` last, which also repairs values already
stored. Anything with an explicit unit, a percentage, or an unparseable
shape passes through untouched — the image and the JVM reject those better
than we can guess at them.

**2. A heap given up front reads as used, and it is not a leak.** Java is
handed the heap as both `-Xms` and `-Xmx` unless `INIT_MEMORY` says
otherwise (the image defaults both to `MEMORY`), and it fills a heap it was
given within the first minute of world generation. Measured upstream on
Paper 1.21.1, 2 GB heap, fresh world, fixed seed, sampled at 0/30/60/120/180 s
after "Done" (docker stats + cgroup anon + java RSS; every figure moved by
under 50 MB across the three minutes):

| Configuration                   | Resident |
| ------------------------------- | -------- |
| no flags                        | 2.60 GiB |
| Aikar's flags                   | 2.59 GiB |
| Aikar's + `-XX:-AlwaysPreTouch` | 1.95 GiB |
| Aikar's + `INIT_MEMORY=512M`    | 1.38 GiB |
| no preset + `INIT_MEMORY=512M`  | 1.25 GiB |

So the flag presets are not the cause and turning pre-touch off only delays
the fill. The one lever that lowers idle memory is a **smaller initial
heap**. That is why `heapPlan()`'s note keys on "starting heap equals maximum
heap" rather than on which preset is on, and why the meters (Overview,
Metrics, the server card's hover) carry it: a 12 GB heap reading 12 GB with
nobody online looks exactly like a leak and generates support noise.

## The startup watchdog and the `stalled` status

A server that enters `starting` and never finishes booting used to sit in
`starting` forever: a hang (unlike a crash) fires no Docker `die`/`oom`
event, and a healthcheck-less container reports `running` from the moment
the JVM starts, so `refreshStatuses()` just re-wrote `starting` on every
poll while the UI kept claiming the server was on its way up.

`refreshStatuses()` now applies a deadline (`STARTUP_STALL_MS`, 10 minutes
since `last_started_at`) and flags such a server `stalled` once, recording a
`startup-stalled` event. Details worth knowing:

- **`stalled` means "still alive, needs attention", not "dead".** The
  container is running; only the boot never completed. Every consumer that
  asks "is this server up?" off the cached row status treats it like
  `running`/`starting`/`unhealthy` — stats and log ingest keep flowing (that
  diagnostic data is exactly what you want at that moment), strict disk
  quota still applies, an upgrade still stops it first, the status page and
  server view model still show live data, and the frontend keeps
  Stop/Restart/Kill offered rather than switching to Start.
- **It is a poll-derived status, re-decided from scratch every 60s.** A
  `stalled` server is re-checked exactly like a `starting` one, so it
  recovers to `running` by itself the moment `Done (` shows up (or the
  healthcheck goes healthy). The event fires only on the
  `starting → stalled` transition, so a long hang does not spam history.
- **Two boot shapes, one deadline.** Healthcheck-less containers still get
  the `Done (`-in-the-log probe (only after `LOG_PROBE_AFTER_MS`, so a
  fresh start costs no log fetch); a container that _has_ a healthcheck and
  simply never goes healthy needs no probe at all — the watcher promotes it
  on `health_status: healthy` — so only the deadline applies there.
- **An unknown start time never stalls.** `parseStartedAt()` returns null
  for an unparseable/empty `last_started_at` (a container started outside
  the panel), and without an elapsed time there is nothing to measure a
  deadline against — such a server keeps the old behavior. That helper also
  exists because the column holds two shapes: the panel's own writes are
  full ISO with `Z`, while a SQL `datetime('now')` default writes
  `YYYY-MM-DD HH:MM:SS` with no zone marker. The previous code appended `Z`
  unconditionally, which turned the first shape into `...ZZ` and made
  `Date.parse` return NaN.

## `dirSize()` and symlinks

`ServerLifecycleService.dirSize()` now explicitly skips
`entry.isSymbolicLink()` before checking `isDirectory()`/`isFile()`. This is
belt-and-suspenders, not a new behavior: `fs.readdirSync(..., {
withFileTypes: true })` returns `Dirent`s whose type comes from the
directory entry itself (effectively an `lstat`), so a symlink was already
never reported as `isDirectory()` or `isFile()` — it was silently skipped
either way. The explicit check exists so the safety property is stated in
the code rather than relying on that implicit dirent behavior, matching the
same explicit skip already present in `StorageIndexService.scan()`,
`WorldArchiveService.dirSize()`, and `FilesService`'s private `dirSize()` —
none of the size-walk implementations in this repo follow a symlink out of
the directory being measured (which also matters for the `safeJoin`
path-guard invariant: a symlink loop or an out-of-tree symlink can't be
used to inflate a size count or read outside the sandboxed server dir).
