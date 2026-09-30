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

## Hangar, SpigotMC and GitHub content (4.29b)

Our own follow-up to 4.29 (no upstream reference). Content installed from Hangar, SpigotMC (via
Spiget) or GitHub Releases is checked and updated like Modrinth/CurseForge content. Files:
`content-latest.service.ts`, the `pick*Update` helpers next to each client in `mods/`,
`ModsService.updateRefFor`, the update and `mods/manual` routes in `mods.controller.ts`,
`content-updates.spec.ts`, and `UpdatesPage.vue` / `BlockedDownloadBanner.vue` on the frontend.

### Per-platform dispatch

`ContentLatestService.latestFor(row, { mcVersion, loader })` is the one place that knows how each
platform answers "what's the newest build of this". `checkAll()` calls it per overlay row and keeps
its existing rule: `isNew = latest.name !== libVersion`, `latest_version` holds `latest.id`. The
Modrinth/CurseForge branches moved there unchanged. `null` still means "nothing to compare
against, leave the cached row alone". For the three new sources, "nothing newer" returns the
installed build itself, so the row is rewritten as up to date.

What each source stores (the ids the install already writes to `library_files`):

| Platform | `latest_version` / `ignored_version` | `latest_name` | changelog link                        |
| -------- | ------------------------------------ | ------------- | ------------------------------------- |
| hangar   | version name (unique per project)    | version name  | the version's Hangar page             |
| spiget   | numeric version id                   | version name  | `spigotmc.org/resources/<id>/updates` |
| github   | tag                                  | tag           | the release's `html_url`              |

### "Newer", per source

- **Hangar** (`pickHangarUpdate`): same MC filter and 50-build window as add-by-link. It follows
  the installed build's channel: a Release build only moves to a newer release, however many
  snapshots are ahead of it (ViaVersion had 50 snapshots and one release in the window when this
  was checked). A Snapshot/Beta build moves to the newest build of any channel, which includes a
  newer release. The user got a snapshot by pinning it, or because the project had no release,
  so staying release-only would strand them on an old snapshot. An installed build that can't be
  looked up counts as release. Never a downgrade: if the installed build is in the list, only
  builds ahead of it count; if it isn't (older than the window, or tagged for another MC version),
  the candidate must be published after it (one cached `getVersion` for its date).
- **SpigotMC** (`pickSpigetUpdate`): version order only. The newest version (Spiget ids only go
  up; `getVersions` sorts by `-id`) is an update when its id is above the installed one.
  `testedVersions` isn't consulted at all, so a stale list can't hide or invent an update, and the
  resource's `external`/`premium` flags don't matter to the check (only to downloading). Known
  limit: some resources reuse one version name (SkinsRestorer publishes every build as `latest`),
  and name-to-name comparison can't see those as updates. Changing that would mean changing the
  name-based contract `listOutdated` and `updateFor` share, which is out of scope.
- **GitHub** (`pickGithubUpdate`): an installed stable release follows `pickGithubRelease` (newest
  stable with jars, so pre-releases are skipped). An installed pre-release takes the newest release
  with jars of either kind. Never a downgrade: when the installed tag is in the list, only releases
  ahead of it count. A tag older than the 30-release window counts as older than all of them.
  Drafts are already dropped by the client.

### GitHub polling and the ETag cache

There's no second polling loop. The check runs on item 3.18's existing cadence (the scheduler's
daily `checkAll`, plus "Check all" on the Updates page) and calls `getReleases(repo)` with its
default window, which is the same request, and so the same `github:<path>` ETag cache row, that
add-by-link's `resolveGithub` uses. Within the 10-minute TTL a check is free; after it, a
revalidation is a 304 that doesn't count against the rate limit.

### One-click update: auto-download or manual upload

`POST .../mods/update` used to refuse anything but Modrinth/CurseForge before building its link.
It now asks `ModsService.updateRefFor(lib, latestVersion)` for a link pinned to the checked build:

- Modrinth/CurseForge/SpigotMC: `refToUrl` with the version id.
- Hangar: `refToUrl('hangar', owner/slug, versionName)`. Library rows keep only the slug, so the
  owner comes from `getProject` (cached for 30 minutes).
- GitHub: a `releases/download/<tag>/<asset>` link. `pickGithubUpdateAsset` keeps the variant that
  was installed: the same asset name (`ProtocolLib.jar`), else the old name with its version
  swapped for the new tag's (`EssentialsXChat-2.21.2.jar` becomes `EssentialsXChat-2.22.0.jar`),
  else `pickGithubAsset`'s default. Without this, updating EssentialsXChat would have installed
  core EssentialsX, the first jar in the release.
- Anything else (`url`, `upload`): 409, as before.

Then, as before, `assertResolvable` runs before anything is removed, through the same
`resolveForServer` as add-by-link. So whether a build is downloadable is decided by exactly the
code that decided it for a fresh install: Hangar external builds and SpigotMC premium/external
resources throw `BlockedDownloadException`, and the route never tries to fetch them. The route
rethrows that 409 with an extra `updateRef` (the pinned link).

The Updates page (`UpdatesPage.vue`, the only place with a one-click update; the Mods tab just
shows the badge) reads that with `blockedUpdateOf(err)` and shows `BlockedDownloadBanner` in
place of a failed toast. The banner's upload posts to `mods/manual` with `url: updateRef` and
`replaceContentId`. `installManualUpload` then:

1. resolves the link again and takes provenance from the registry, as for any blocked install;
2. checks the row to replace is on this server, isn't pack-managed, and is the same
   `platform`/`projectId` as the link (a 400 otherwise, before anything is imported), so the
   replace can't be pointed at unrelated content;
3. after the hash check and library import, removes the old row, adds the new one with the old
   row's `kind` and `importId`, and disables it again if the old one was disabled, the same things
   the update route preserves.

### `ignored_version`

Nothing was special-cased. The new sources put a platform id in `latest_version` that changes
exactly when a newer build appears, which is all the self-clearing rule needs. The spec checks the
whole cycle for all three: ignore, a re-check that finds the same builds keeps them ignored, a new
build brings the row back and empties the ignored list.

### Verification

`content-updates.spec.ts` covers the pickers, `checkAll` against the real migrations with the real
clients (fetch stubbed), `ignored_version`, the shared GitHub cache row, `updateRefFor`, the update
route's routing and the replace path of `installManualUpload`. Checked live against the real
registries (Sept 2026), calling `ContentLatestService` and `updateRefFor` + `assertResolvable`
directly: ViaVersion on Hangar (release 5.11.0 goes to 5.12.0, not the 50 newer snapshots; a
snapshot goes to the newest snapshot; downloadable), EssentialsX on Hangar (external build,
blocked), LuckPerms on SpigotMC (5.4.131 goes to 5.5.71, with `testedVersions` that don't list
1.21.4), VoteParty (premium, blocked) and SkinsRestorer (external, blocked), EssentialsX and
ProtocolLib on GitHub (asset variant kept, downloadable). The full install-then-update flow in a
running panel wasn't exercised, since it needs a Docker-backed server; the panel was booted to
check the new provider wiring.
