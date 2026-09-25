# Settings module notes

## Admin-configurable defaults for new servers (upstream parity 3.19)

Upstream reference: `anefzaoui/minecraft-server-manager` commit `fcb6266` ("Make
new-server defaults admin-configurable (Bug 4)"). Different stack (Express/
Handlebars/raw-ws, single SQLite) — read for behavior only, nothing ported.

**What upstream actually made admin-configurable**, per its diff and
`test/settings-defaults.test.js`: exactly the six resource-sizing fields —
`heapMb`, `containerMemoryMb`, `cpus`, `diskQuotaGb`, `quotaWarnPct`,
`quotaCriticalPct`. Not MC version/loader/type/difficulty/gamemode — those
aren't part of this upstream item at all in either stack.

### How it fits our `ResourceDefaultsResolver`

`ResourceDefaultsResolver.resolve()` (`backend/src/config/resource-defaults.resolver.ts`)
already derives these same six fields from host memory + optional
`DEFAULT_HEAP_MB`/`DEFAULT_CONTAINER_MEMORY_MB`/`DEFAULT_DISK_QUOTA_GB` env
vars, resolved once at boot into `ConfigService.defaults`. That resolver is
**unchanged** — it's still the sole source of the "built-in" base value for
every field, and still env/host-derived, matching upstream's own
`config.defaults` (its env-derived base) staying untouched too.

What's new is a layer on top, mirroring upstream's `settings.getDefaults()`:

- `SettingsService.getEffectiveDefaults()` — `ConfigService.defaults` merged
  with a saved partial override (DB-backed via the existing key/value
  `settings` table, key `server_creation_defaults`, JSON-encoded — the same
  storage `ApiTokensService`/`getPublicHost`/etc. already use via
  `SettingsService.get`/`set`/`remove`; no new table, no schema change).
- `SettingsService.setServerDefaults(patch)` — sanitizes + clamps a partial
  patch (bounds mirror the existing server create/patch zod schemas in
  `api/servers.controller.ts` and the blueprint resource schema in
  `blueprints/blueprints.types.ts`, so a saved default can never produce a
  value those endpoints would themselves reject) and merges it onto any
  existing override.
- `SettingsService.resetServerDefaults()` — clears the override key; back to
  the resolver's built-in value.

### API

`GET /api/settings/defaults` — any signed-in user, mirrors the existing
`GET /api/settings`'s already-public `defaults` field. `POST
/api/settings/defaults` — admin-only (`@Roles('admin')`, same guard pattern as
`ApiTokensController`/`PermissionsController`), body is a partial patch of the
six fields, or `{ reset: true }`. Both return `{ ok, defaults, base }` —
`defaults` is the effective value, `base` is `ConfigService.defaults` (the
built-in), so the UI can show "custom" vs. "using built-ins" and implement a
"Restore built-ins" action. `GET /api/settings`'s top-level response also now
exposes `defaults` (effective, was previously always the raw
`config.defaults`) and a new `defaultsBase` field for the same built-in
comparison, so the existing "Defaults for new servers" Settings-page card
didn't need a second fetch.

### Where the effective defaults are consumed

- `ServerLifecycleService.createServerImpl` — `this.config.defaults` →
  `await this.settings.getEffectiveDefaults()`. Per-request `heapMb` /
  `containerMemoryMb` / `cpus` / `diskQuotaGb` on the create call (already
  supported — `input.heapMb ?? defaults.heapMb`, etc.) still win: these are
  _defaults_, not enforced policy, exactly like upstream's design.
- `ServerPreviewService.previewCreateSpec` — same swap; the method is now
  `async` (was sync) since `getEffectiveDefaults()` is a DB read. Its one
  caller (`DockerAdminController.dockerPreview`) awaits it.
- `BlueprintsLibraryService.starterResources()` — **deliberately left on**
  `this.config.defaults` (unchanged). This only feeds the four _built-in_
  starter blueprints seeded once on first run (`writeManifestOnlyBlueprint`
  during first-run seeding), before an admin account — let alone an admin
  override — can exist. Wiring it to `SettingsService` would add an await
  plus a `SettingsModule` dependency to a one-shot boot-time path for no
  behavioral benefit (the override can't exist yet when it runs, and once a
  blueprint is written its resources are static — a later admin default
  change wouldn't retroactively touch it either way). User-created
  blueprints already capture whatever resource values were in effect (via
  the create/patch endpoints, which do go through `getEffectiveDefaults()`)
  at the time they were made.

### Defense-in-depth note

No new validation layer was added beyond the existing clamp-on-write (mirrors
already-established bounds, doesn't invent new ones) — this stayed inside the
"store some default field values, read them back to pre-fill the create form"
shape the task called for. Per-field clamping happens once, in
`SettingsService.sanitizeDefaultsPatch`, not duplicated elsewhere.

## Panel self-update check (upstream parity 3.23)

Upstream reference: `anefzaoui/minecraft-server-manager` commit `f714b06` ("Add
'Update MSM' check on the Settings page (Bug 6)"). Different stack (Express/
Handlebars/raw-ws, single SQLite, `test/panel-update.test.js`) — read for
behavior only, nothing ported. This checks for a newer release of **the panel
application itself**, a completely different kind of "update" from
`backend/src/updates/` (which checks Modrinth/CurseForge/GTNH for a newer
modpack/mod build for a _server's_ content — see `updates/UPDATES_NOTES.md`).
Different data source (GitHub Releases vs. game-content platforms), different
subject (the panel vs. a server's content), and no relation to
`update_checks`' pack/content rows — so this lives as a small, separate
`PanelUpdateService` in `settings/` rather than bolted onto `UpdateCheckerService`.

### What upstream actually built, confirmed from the commit + test

- Compares the installed version against the **newest GitHub Release only**
  (`releases[0]` after upstream's own `getReleases` filters out drafts) — never
  a pre-release/draft, never a bare tag with no Release object.
- **Read-only**: "never modifies panel files"; there is no apply/self-update
  path in upstream's implementation, and this port adds none either.
- **On-demand only** at the page level: upstream's test explicitly asserts
  rendering `/settings` never calls GitHub (`spy.mock.callCount() === 0`) — the
  check only runs when the button (or the API endpoint) is hit.
- **Admin-only**: upstream's test asserts operator and viewer both get 403 from
  `GET /api/settings/panel-update`; only admin gets 200. This surprised the
  initial assumption that a read-only, public-API-backed check wouldn't need
  gating — upstream gates it anyway, so this port matches that (`@Roles('admin')`
  on the route, same `RolesGuard` pattern as every other admin-only settings
  mutation in this controller).
- **Graceful degradation**: a GitHub failure with something already cached
  returns the last known-good result with an `error` field set (not a hard
  failure); nothing cached at all is the only case that surfaces as an error
  state to the caller.

### Design differences from upstream (stack-appropriate, not behavior changes)

- **"Latest release" endpoint over "list releases"**: upstream calls
  `GET /repos/:repo/releases?per_page=1` and takes index 0, whose "no
  pre-release" guarantee actually comes only from its own client-side `draft`
  filter (its `prerelease` flag is carried through but never checked before
  taking `releases[0]`). This port uses GitHub's dedicated
  `GET /repos/:repo/releases/latest` endpoint instead, which GitHub itself
  defines to return the most recent published release that is **neither a
  draft nor a pre-release** — the "newest stable release only" rule the task
  called for, enforced server-side with no client-side filtering to get wrong.
  A repo with no published releases yet gets a 404 from this endpoint, treated
  as a normal "nothing to report" outcome (`latest: null`), not an error.
- **Cache location**: upstream keeps a dedicated `panel-latest-release` row in
  its ETag-cached `api_cache` table (shared with its generic GitHub client).
  This codebase's `ApiCacheService`/`api_cache` table exists for the same kind
  of thing, but the task specifically calls for reusing `SettingsService`'s
  key/value `settings` table instead (the same one `server_creation_defaults`
  and `backup_retention_ceilings` above already use) — one more read/write
  path to keep track of would be pure overhead for a single cached value with
  no ETag revalidation need (GitHub's per-repo release list changes rarely and
  this call has no meaningful rate-limit pressure at panel-Settings-page
  frequency). Stored under key `panel_update_check` as one JSON blob:
  `{ latestVersion, latestTag, releaseName, releaseUrl, publishedAt, checkedAt, error }`.
- **Current version source**: upstream reads its own `package.json` at
  `require()` time — a single-process app where that file always ships with
  the running code. This repo's backend and frontend are built and versioned
  independently (see `Dockerfile`'s `APP_VERSION` build ARG, baked from the
  released git tag at image build time — `frontend/quasar.config.ts` already
  exposes it to the SPA footer as `import.meta.env.APP_VERSION`). Since both
  processes run in the same container and share the same env,
  `PanelUpdateService.getCurrentVersion()` just reads `process.env.APP_VERSION`
  directly — no new file read, no new build step, and it can never drift from
  what the frontend footer already shows. Falls back to `"dev"` for any build
  that didn't set it (local/manual runs), matching the frontend's existing
  convention; `compareVersions()` treats `"dev"` as an unparseable version (not
  semver-shaped) and never claims an update is available against it, the same
  conservative "unknown shape ⇒ null ⇒ not newer" rule upstream's own
  `compareVersions` test enforces for non-semver tags.
- **Passive re-check TTL instead of purely on-demand**: the task allows "maybe
  a periodic re-check on Settings-page load" as an alternative to a new
  scheduler, so `check({ force })` re-hits GitHub on a passive call only if the
  cached result is more than an hour old (`MIN_RECHECK_INTERVAL_MS`); the
  "Check now" button always passes `force: true` to bypass that. No new
  scheduled job, no cron — this is a plain TTL check inline in the read path,
  same shape as `ApiCacheService`'s ttlMs pattern used throughout `mods/`.
- **Never throws to the caller**: instead of upstream's 502-when-nothing-
  cached, this port always returns `{ ok: true, update: {...} }` with
  `update.error` set on failure (including the "nothing ever cached" case,
  where every version/URL field is simply `null`). Simpler for the frontend to
  render (one code path: check `error`, else check `updateAvailable`) and
  strictly less code than adding a distinct HTTP-error branch on top of the
  already-required error-field branch — not a defense-in-depth trade-off, just
  the less complex of two equivalent shapes.

### API

`GET /api/settings/panel-update` (optional `?refresh=1` to force a real
lookup, bypassing the TTL) — admin-only. Returns
`{ ok: true, update: PanelUpdateStatus }` (`shared/types/settings.d.ts`).

### No self-update mechanism

This is a version _check_ only. Nothing in `PanelUpdateService`, the
controller route, or the frontend card writes to disk, restarts a process, or
touches a container — the admin downloads and applies a new release
themselves (e.g. by pulling the new image tag), exactly like upstream's own
"never modifies panel files" design.
