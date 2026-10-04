# MaintenanceModule notes

The scheduled `db-maintenance` task (seeded at `15 4 * * *`, visible and editable
on the Schedules page like the other panel-wide tasks) calls
`MaintenanceService.run()`. Ports upstream 0.10.0/0.13.0's panel-DB snapshot,
boot integrity check and bounded pruning (see `UPSTREAM_PARITY.md`).

## Why a schedule and not a hidden timer

Upstream ran this from a private `setInterval` 60 s after boot. Here it rides the
existing scheduler, so it is visible, can be moved or disabled, and does not
fire on every restart. `seedGlobalDefaults()` inserts it on boot if missing, so
existing installs pick it up without a migration.

## Steps are isolated

`run()` prunes, then snapshots, each in its own try/catch that logs instead of
throwing: it runs unattended, and a prune failure must never cost the day's
snapshot (or the reverse).

## Retention (`RetentionService`)

| Table             | Kept  | Notes                                                                                                            |
| ----------------- | ----- | ---------------------------------------------------------------------------------------------------------------- |
| `player_events`   | 90 d  | by `ts`                                                                                                          |
| `player_sessions` | 90 d  | closed sessions only, by `ended_at`; open ones are never deleted                                                 |
| `events`          | 365 d | via `EventsService.pruneEvents`, which also removes log excerpts                                                 |
| `api_cache`       | 30 d  | keys under `item-registry:` are skipped: they are fingerprint-validated, so age-pruning forces a full jar rescan |

Before this, nothing ever called the analytics prune (it existed on
`LogIngestService` with no caller, now moved here), `events` only pruned on a
manual admin action, and `api_cache` was never pruned. Cutoffs are JS-computed
strings so the same query runs on SQLite and Postgres. No settings or env vars:
the windows are constants until a real setup needs different ones.

This module imports nothing (DbService, EventsService and PathGuardService are
`@Global`). Do not import `AnalyticsModule` here: SchedulerModule depends on this
module, and AnalyticsModule -> ServersModule -> SchedulerModule would be a cycle.

## Snapshot (`PanelDbService`)

- `VACUUM INTO ?` on a second connection in a worker thread (inline `eval`
  worker, so there is no separate file to ship in `dist/`), then a `quick_check`
  of the copy. Written as `*.partial` and renamed, so a half-written file is never
  taken for a good snapshot; `*.partial` never counts toward retention.
- `data/backups/_panel/panel-<UTC stamp>.db`, newest 14 kept, mode 0600 (the file
  holds password hashes, encrypted secrets and 2FA state).
- Postgres: `pg_dump` custom-format archive (`panel-<stamp>.dump`), validated
  with `pg_restore --list`, same `.partial`/rename/0600/retention handling.
  Details and the reasons for shelling out are in `db/DRIZZLE_NOTES.md`.
- Retention counts both `.db` and `.dump` files, so switching driver doesn't
  strand old snapshots.

## Boot check (SQLite)

`PanelDbService.onApplicationBootstrap` runs `PRAGMA quick_check` (cheaper than
`integrity_check`, still catches page-level corruption) after `main.ts` has run
migrations. It only logs: a corrupt database will not fix itself, but refusing to
boot would lock the operator out of the panel that tells them how to recover.
