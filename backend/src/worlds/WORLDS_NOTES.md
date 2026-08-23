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

## Known type-system wrinkles fixed post-port

- `@types/archiver@8.0.0` ships no factory-function signature (only the
  `Archiver` class) — `archiver('zip', {...})` isn't typeable against it.
  Matches legacy's own untyped `require('archiver')` — kept untyped here
  too (`const archiver = require('archiver')`) rather than fighting the
  types for a call the package genuinely supports at runtime.
- `yauzl` has no types anywhere (`@types/yauzl` only covers the 2.x line;
  this repo pins 3.4.0) — copied the legacy repo's hand-rolled
  `types/yauzl.d.ts` into `backend/src/types/yauzl.d.ts` verbatim.
