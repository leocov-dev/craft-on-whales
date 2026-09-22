# Updates module notes

## Storage shape: `update_checks` is already 1:1 per subject

`update_checks` (`backend/src/db/schema/misc.ts`, mirrored in `schema-pg/misc.ts`) has a
composite primary key `(subject_type, subject_id)` — one row per pack (`subject_type='pack'`,
`subject_id=server.id`) or per overlay mod (`subject_type='content'`, `subject_id=server_content.id`).
Because a subject can only ever have one "currently known latest" build at a time
(`latest_version`/`latest_name`), a single nullable `ignored_version` column on that same row is
enough to model "ignore this update" — no side table needed. This is the minimal shape; see the
`OutdatedRow`-shaped design note in `updates.types.ts` for the row-level fields it powers.

## What "ignored" means

`ignored_version` holds the platform id (same id space as `latest_version` — a Modrinth/CurseForge
file/version id, a GTNH index id, etc., **not** the human-readable name) of the build the user last
dismissed for that subject.

A row counts as "ignored" **only** while `ignored_version === latest_version`. That single
comparison is the whole supersession rule:

- `UpdateCheckerService.ignoreUpdate()` sets `ignored_version := latest_version` (whatever the
  checker currently believes is newest) for that subject.
- The next `checkAll()` run's `upsertCheck()` **never touches `ignored_version`** — it only sets
  `current_version`/`latest_version`/`latest_name`/`changelog_url`/`checked_at`. So when a newer
  build is published, `latest_version` changes to the new id while `ignored_version` still holds
  the old one — they no longer match, and the row stops being "ignored" automatically. No cleanup
  job, no explicit "supersede" step.
- If the build the user ignored is later reapplied (they never actually update, or the current
  latest just happens to equal the ignored one again after a checker re-run), the row goes back to
  being suppressed — which is the correct "I don't want to hear about this build" semantics.
- Applying the pinned/installed version to match `latest_version` (a real upgrade) makes
  `upsertCheck` write `latest_version: null` (see `upsertCheck`'s "isNew" contract) on the next
  check, which clears the row out of both `listOutdated()` and `listIgnored()` — the stale
  `ignored_version` value left behind is harmless dead data at that point, not read by anything.

This means "ignore build N, get notified again at N+1" falls out of the existing
current/latest-version comparison the checker already does — no new comparison logic, no semver
parsing. It reuses whatever identity the platform already gives each build (opaque ids compared for
equality), the same way `listOutdated`/`updateFor`/`hasPackUpdate` already did before this feature
existed.

## Where ignore-state is threaded through

Every place that currently reads `update_checks` to answer "is there an update" was extended with
the same one-line guard (`ignoredVersion && ignoredVersion === latestVersion` ⇒ treat as not
outdated):

- `UpdateCheckerService.listOutdated()` / `listIgnored()` — the Updates page's two lists.
  `listOutdated()` also takes `includeIgnored` internally; `listIgnored()` is just
  `listOutdated({ includeIgnored: true })`.
- `ModsService.updateFor()` — per-mod badge on the Mods tab / mod listing.
- `ServerViewModelService.hasPackUpdate()` — the per-server `updateAvailable` flag (dashboard tile
  count, server card badge).

There is no separate "auto-update policy" consumer to thread through: `servers.update_policy`'s
`'auto'` value is stored (schema, blueprints, the servers API) but nothing in this codebase
currently reads it to auto-apply an update — `UpdateUpgradeService`'s upgrade flow is only ever
invoked explicitly (by a user or a scheduled task calling the upgrade endpoint), never by the
scheduler or checker themselves. If an actual auto-apply path is added later, it should read
`update_checks` through `listOutdated()` (or the same ignored-version guard) so it inherits this
for free rather than re-deriving "is there an update" against the raw table.

## API

`UpdatesController` (`backend/src/api/updates.controller.ts`):

- `POST /api/updates/:subjectType/:subjectId/ignore` — ignore the subject's current
  `latest_version`. 409 if the checker doesn't currently know of a newer build for it (nothing to
  ignore).
- `DELETE /api/updates/:subjectType/:subjectId/ignore` — clear `ignored_version` unconditionally.
- `subjectType` is `'pack' | 'content'`, `subjectId` is `server.id` (pack) or `server_content.id`
  (content) — the same composite key `update_checks` itself uses.

Both routes are gated by `ServerPermissionGuard` + `@RequireServerPermission('content', resolve)`
(the same `content` capability the mods/pack update-apply routes already require), with a custom
resolver (`updateSubjectServerId`) that looks up the owning server id from `server_content` for the
`content` case — following the existing `backupServerId` pattern in `backups.controller.ts`.
