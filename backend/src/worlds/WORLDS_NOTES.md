# WorldsModule notes

`src/services/worlds.ts` (1370 lines) and `src/services/backups.ts` (320
lines) were split per SOLID into:

- `WorldArchiveService` — pure archive/hash primitives (zip/tar create,
  extract, world-root detection, sha256), no DB/Docker dependency.
- `WorldPropsService` — `server.properties` + active-level bookkeeping.
- `WorldLibraryService` — import/export to/from the shared library
  (`LibraryService`).
- `WorldOperationsService` — the container-facing operations (save-off/on,
  duplicate, download, delete) that tie the above together via
  `ContainerService`/`ServerLifecycleService`/`ServerQueryService`.
- `WorldSaveLockService` — ports `src/services/serverLocks.ts` +
  `src/utils/keyedMutex.ts`'s `withSaveLock`. Distinct from
  `backend/src/servers/server-locks.service.ts`'s `ServerLocksService`,
  which guards a different concern (lifecycle-op concurrency, not the
  save-off/copy/save-on critical section).
- `BackupsService` — ports `src/services/backups.ts` verbatim
  (`createBackup`/`restoreBackup`/`deleteBackup`/`pruneRetention`); legacy
  never exported a list function either (route layer queries the `backups`
  table directly), so none was added here.

## Backup retention buckets

`BackupsService.RETENTION_BUCKETS` caps every reason bucket, per server, and
prunes each one INDEPENDENTLY:

| reason        | keep | why                                                        |
| ------------- | ---- | ---------------------------------------------------------- |
| `manual`      | 20   | user-chosen; the most valuable, so the largest ceiling     |
| `scheduled`   | 10   | recurring and cheap to re-take                             |
| `pre-update`  | 10   | one per pack upgrade; bounded by upgrade frequency         |
| `pre-restore` | 5    | automatic safety snapshots; small, and isolated on purpose |

The original rule was a single `KEEP_SCHEDULED = 10` with manual and
pre-update never auto-pruned — unbounded, so a long-lived server accumulated
backups until the free-space preflight started failing every new one. The
`pre-restore` reason exists specifically so that safety snapshots (taken
before a restore in `BackupsService.restoreBackup`, before a world reset in
`WorldLifecycleService`, and before replacing the active world in
`WorldTransferService`) can never evict a `manual` backup the user chose to
keep: they only ever compete with each other. Pruning is therefore per bucket,
never against a global total.

Two mechanics worth knowing:

- The stale set is computed by ordering a bucket's rows newest-first and
  slicing in JS, not with SQL `OFFSET`. A bare `OFFSET` with no `LIMIT` is a
  syntax error in SQLite, and the `LIMIT -1` workaround is rejected by
  Postgres — see `../db/schema/DUAL_DIALECT_NOTES.md`. Buckets hold tens of
  rows, so the read is trivial.
- `pruneRetention` never throws and isolates each delete: it runs after a
  backup that already succeeded and is already recorded, so a retention
  failure must never surface as that call failing.

`reason` is a free-text column in both dialects (no `CHECK` constraint —
see `../db/DRIZZLE_NOTES.md`), so adding `pre-restore` needed no migration;
`drizzle-kit generate` reports no schema change for either dialect.

## Backup rename + age/size retention ceilings (upstream parity 3.20)

Upstream (`c12c445`, Express/raw-ws/single-SQLite — different stack, ported for
_behavior_ only) added two things on top of the count buckets above: a rename
endpoint, and two opt-in panel-wide ceilings (max age, max total size).

**Rename (`BackupsService.renameBackup`)** — unlike upstream, this does NOT
rename the archive file on disk. It sets a new nullable `backups.custom_name`
column (added in both `db/schema/blueprints.ts` and `db/schema-pg/blueprints.ts`,
migrated via `drizzle-kit generate` in both dialects) and leaves `filename`/
`relPath` untouched. Reasons for diverging from upstream's on-disk rename:

- It avoids adding filesystem rename logic (collision handling, a second path
  through `PathGuardService`) for a feature that's purely cosmetic — smaller
  surface area for the same user-visible result (a friendly name in the UI).
- `filename`/`relPath` stay the single source of truth for where the archive
  actually lives, so download/restore/retention code that reads those columns
  needed zero changes.
- A rename is a no-op with respect to `reason`/`createdAt`/retention bucketing
  by construction, since it touches one unrelated column — no special-casing
  needed anywhere else, matching upstream's own "rename doesn't move it
  between buckets" behavior without having to say so.

The API returns `customName` alongside the existing `file` (=`filename`) field;
the frontend shows `customName || file` and, when a custom name is set, the
original filename as a caption underneath.

**Age/size ceilings** — panel-wide, not per-server: `SettingsService` gains
`getBackupRetentionCeilings()`/`setBackupRetentionCeilings(patch)`, storing
`{ maxAgeDays, maxTotalGb }` (both `0` = disabled, matching upstream's opt-in
default) as a JSON blob under one `settings` key (`backup_retention_ceilings`)
— the same partial-patch-under-one-key mechanism as `server_creation_defaults`
(3.19) and `ApiTokensService`'s toggle. No new table, no per-server override
(upstream has one; this port only needed the panel-wide case — no product
requirement surfaced for per-server overrides here, and adding one would be
speculative config per `AGENTS.md`).

`BackupsService.pruneRetention` runs three passes, in order, against a server's
backups:

1. **Per-reason count buckets** (`RETENTION_BUCKETS`, unchanged from above).
2. **Age ceiling** (opt-in): among what's left after (1), delete anything
   older than `maxAgeDays`, any reason, except the single newest backup for
   the server.
3. **Size ceiling** (opt-in): among what's left after (2), if the server's
   total backup size still exceeds `maxTotalGb`, delete oldest-first — but
   sacrifice `pre-restore` snapshots before `scheduled`, before everything
   else — until back under the cap, again except the single newest backup.

**The single newest backup for a server is never a pruning candidate in any of
the three passes** — this is the upstream test suite's load-bearing invariant
(`test/backups-retention.test.js`: "the newest backup is always kept", even
when it's the only backup and it individually violates a ceiling). A server
must never end up with zero backups because it went quiet or its world grew
past a size ceiling. `backups.service.spec.ts`'s age/size ceiling tests cover
this directly, including the single-backup-violates-the-ceiling case.

Ceiling comparisons parse `created_at` with the same `.replace(' ', 'T') +
'Z'` idiom already used in `WorldLibraryService` for SQLite's
`datetime('now')` text format, rather than doing the comparison in SQL — see
`../db/schema/DUAL_DIALECT_NOTES.md` for why cross-dialect date SQL is
avoided here the same way `pruneRetention`'s count-bucket slicing already
avoids `OFFSET`.

API: `PATCH /api/backups/:backupId` (rename, `{ name }`) is gated exactly like
the existing `DELETE`/download routes — `ServerPermissionGuard` +
`@RequireServerPermission('backups', backupServerId)`, so per-server
permissions (not just role) apply. `GET`/`POST /api/settings/backup-retention`
(`{ maxAgeDays?, maxTotalGb? }`) mirrors `GET`/`POST /api/settings/defaults`'s
shape exactly: any signed-in user can read, only `admin` can write.

## Backup archive integrity check

`createBackup` reopens each finished archive with
`WorldArchiveService.zipEntryCount` before inserting the DB row. Reading the
central directory is cheap (no decompression) but proves the zip is
structurally sound; a torn archive (disk filled mid-write despite the
preflight, an archiver fault) is deleted and the call fails, instead of the
corruption being discovered at restore time — the one moment when the backup
is all that stands between the operator and data loss. A zero-entry archive is
structurally valid (a server that has never started has nothing on disk), so
it is recorded but flagged as a warning on the `backup-created` event.

## Testing note: archiver is ESM-only

`backups.service.spec.ts` pulls in `archiver` transitively (`ZipArchive`), and
archiver v8 is `"type": "module"`. Jest's default
`transformIgnorePatterns` leaves `node_modules` untransformed, so the import
blew up with `Cannot use import statement outside a module`. The fix is the
allowlist in `backend/package.json`'s jest config — archiver plus its ESM
dependency chain (`zip-stream`, `compress-commons`, `crc32-stream`,
`readdir-glob`, `lazystream`, `normalize-path`, `is-stream`, `buffer-crc32`,
`bl`, `readable-stream`) is transformed like first-party code. Trimming that
list to just `archiver` fails on the nested `archiver/node_modules/is-stream`.

## Deferred (TODO markers)

Two genuine bidirectional cycles from the plan's require-cycle audit —
`worlds.ts ↔ map.ts` — surfaced at two call sites, both marked
`// TODO(MapModule)` and documented inline where they live:

1. `ServerEnvironmentService.mergeExtraPorts` (`backend/src/servers/`) —
   BlueMap port merge, safe no-op today.
2. `WorldPropsService`'s active-level bookkeeping (class doc comment +
   inline marker) — legacy `setActiveLevel` calls
   `mapService.writeMapConfigs` to keep BlueMap pointed at the active world
   after a rename/switch. Until `MapModule` exists and this is wired via
   `forwardRef()`, a rename/switch after enabling BlueMap will silently
   leave the map viewer pointed at the old world.

`worlds.ts`'s forward dependencies on `./library` and `../storage/indexer`
are NOT deferred — both are real, already built: `LibraryService` (a scoped
port, see `backend/src/library/library.service.ts`'s own doc comment for
what's included vs. deferred to the plan's later full `LibraryModule` pass)
and `StorageIndexService` (`backend/src/storage/storage-index.service.ts`).

## Verification

`tsc --noEmit` clean. Full boot (migrations run, all modules wire,
`WorldsModule dependencies initialized` in the Nest log) confirmed. Smoke
tests: `WorldSaveLockService.withSaveLock` — two overlapping calls on the
same key serialize correctly (A fully completes before B starts). A real
`servers` row insert against the live Drizzle schema (satisfying every
`NOT NULL` column) succeeds, confirming the FK relationship `backups.ts`
relies on is wired correctly. `createBackup`/`restoreBackup` weren't
exercised live since they need a real Docker container (`execCapture`/
`inspectStatus`) and real world files — confirmed by typecheck + code
review only, not a live run.

## Download routes gated to admin/operator (upstream parity 2.15)

`WorldsController`'s `GET :id/download` (library world) and
`ServerWorldsController`'s `GET :world/download` (per-server, calls
`WorldTransferService.prepareWorldDownload`, which actually pauses saves
and zips a fresh snapshot to `data/tmp`) both carry `@Roles('admin',
'operator')` now. A bare GET streaming a full world save — potentially
player data, and for the per-server route a real on-the-fly side effect,
not just a read — was reachable by a logged-in `viewer` with no CSRF-shaped
request needed (`OriginGuard` only gates non-GET verbs). Matches the same
gate already on `backups.controller.ts`'s backup download. See
`backend/src/auth/guards/roles.guard.side-effecting-gets.spec.ts`.

**Frontend caveat**: `WorldsPage.vue` and `server/WorldsTab.vue`'s download
buttons render unconditionally for every logged-in role today (no
`viewer`-hiding logic exists client-side for these, or for any of the other
routes this PR gated). A `viewer` clicking Download now gets a 403 instead
of a file — flagged, not fixed, here; hiding/disabling those buttons for
non-operator roles is frontend follow-up work, out of scope for this
backend-only change.

## Known type-system wrinkles fixed post-port

- `@types/archiver@8.0.0` ships no factory-function signature (only the
  `Archiver` class) — `archiver('zip', {...})` isn't typeable against it.
  Matches legacy's own untyped `require('archiver')` — kept untyped here
  too (`const archiver = require('archiver')`) rather than fighting the
  types for a call the package genuinely supports at runtime.
- `yauzl` has no types anywhere (`@types/yauzl` only covers the 2.x line;
  this repo pins 3.4.0) — copied the legacy repo's hand-rolled
  `types/yauzl.d.ts` into `backend/src/types/yauzl.d.ts` verbatim.
