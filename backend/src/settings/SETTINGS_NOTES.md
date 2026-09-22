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
