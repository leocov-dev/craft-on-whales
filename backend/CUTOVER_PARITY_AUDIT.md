# Cutover parity audit: legacy routes vs. new backend

Method: extracted every `router.get/post/put/patch/delete(...)` registration
from all 19 legacy route files under `src/web/routes/*.ts` (excluding
`index.ts`, confirmed pure dead Handlebars view-rendering code with zero
JSON endpoints, and `dockerOverridesSchema.ts`, a zod schema fragment not a
route file), resolved every sub-router's actual mount prefix by reading
`src/web/app.ts` and `src/web/routes/api.ts`'s internal `router.use(...)`
calls, and cross-referenced against the new backend's real boot-time route
table (`RouterExplorer] Mapped {...}` log lines from a live `node dist/main.js`
run — not controller-decorator grepping, which undercounts/miscounts due to
controller-level path prefixes).

Two extraction pitfalls hit and corrected during this audit, worth knowing
about if this is re-run later:

- `worlds.ts` and `files.ts` each export TWO distinct sub-routers from one
  file (`router`+`serverWorlds`, `serverFiles`+`globalFiles`) — a naive
  single-pass extraction double-counts or misses routes depending on which
  identifier it greps for.
- `api.ts`'s five lifecycle-action routes (`start`/`stop`/`restart`/`kill`/
  `recreate`) are registered in a `for` loop over a template-literal path
  (`` `/servers/:id/${action}` ``), not a literal string — any regex looking
  for a quoted path string misses all five entirely. Initially misreported
  as "new capability added during the rewrite" until traced back to source.

## Summary

- **206** legacy JSON-API route registrations found (across 19 files).
- **201** ported to the new backend with an equivalent route.
- **4** deliberately dropped — confirmed via source read, not assumed:
  `GET /login`, `GET /setup`, `GET /login/2fa` (`src/web/routes/auth.ts`),
  `GET /status/:slug` (`src/web/routes/status.ts`) — all four are pure
  `res.render(...)` Handlebars view routes with no JSON response path; each
  has a JSON twin that IS ported (`GET /setup/checks`, `POST /login`,
  `POST /login/2fa`, `GET /status/api/:slug`).
- **1** genuinely missing (see below).
- New backend has **202** total routes: 201 legacy-equivalent + 1 new
  (`GET /` — the unedited Nest CLI scaffold's `AppController` stub,
  harmless, not a real feature route).

## Missing endpoint

| Method | Legacy path          | File                        | What it does                                                                                                                                              | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------ | -------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/docker/status` | `src/web/routes/api.ts:459` | Returns `{ok:true, docker: await checkDocker()}` — the Docker daemon health/version/OS probe used by the dashboard/settings UI to show connection status. | Trivial — `DockerConnectionService.checkDocker()` already exists and is already used identically by `backend/src/auth/auth.controller.ts`'s `GET /setup/checks` (`this.docker.checkDocker()`). Just needs a one-method `@Get('docker/status')` added to an existing controller (`backend/src/api/servers.controller.ts` is the natural home — it already has the other `docker/*` endpoints: `docker/networks`, `docker/preview`, `docker/preview/parse`) injecting `DockerConnectionService` and returning `{ ok: true, docker: await this.docker.checkDocker() }`. |

No other gaps found. **Fixed** (post-audit, by the coordinating session):
`GET /api/docker/status` added to `servers.controller.ts`, exactly as
described above — `DockerConnectionService` injected, one-line handler.
Typecheck clean; endpoint parity is now 202/206 legacy JSON endpoints
ported (206 - 4 deliberately-dropped-view-routes = 202 real targets, all
202 now covered).

## URL-path mismatches that would break the frontend

None found. Every ported route's path matches what `frontend/src/api/*.ts`
actually calls (spot-checked the ones most likely to drift: `servers`,
`worlds`/`serverWorlds`, `files`, `inventory`'s global-search mount at
`/api/inventory/search` vs. the per-server mount at
`/api/servers/:id/inventory/*`, and `blueprints`).

## Real-data migration test (separate from the route audit above)

Performed live, not simulated: booted the actual LEGACY app (`node -r
tsx/cjs src/server.ts`) against a scratch `DATA_DIR`, ran its own real
migration set, created a real admin user and a real server row through it
(genuine `POST /setup` + `POST /api/servers` calls, not a hand-inserted
row), then pointed the NEW backend at a copy of that exact data directory.

**Found and fixed a real, boot-crashing bug**: `drizzle-orm`'s `migrate()`
has no concept of "this DB's schema already exists from a different
migration system" — it only tracks its own bookkeeping table
(`__drizzle_migrations`). Against a legacy-created DB, that table doesn't
exist yet, so `migrate()` assumed a brand-new DB and tried to `CREATE
TABLE` everything from scratch, crashing with `table already exists` on
the very first table. This would have broken EVERY real upgrade from the
pre-rewrite app to the new backend — the plan's "copy `$DATA_DIR` to
migrate the panel" guarantee did not hold before this fix.

**Fix**: `backend/src/db/migrate.ts` now detects this exact case (no
`__drizzle_migrations` table, but a `servers` table already exists) and
baselines the current migration set as already-applied — via
`readMigrationFiles()` plus a manual insert into `__drizzle_migrations`
matching Drizzle's own row format — instead of executing the CREATE TABLE
statements a second time. A genuinely fresh install (no `servers` table
either) still runs `migrate()` normally. See the inline comment in that
file for the full reasoning.

**Re-verified after the fix**: same live legacy-DB copy, new backend now
boots clean, logs `[migrate] adopted existing schema — baselined 1
migration(s) without re-running them`, and the real `MigrationTest` server
row created through the legacy app is queryable through the new backend's
`GET /api/servers` with the correct shape. The migration guarantee holds.

## Docker lifecycle test

This sandboxed environment has no local Docker daemon — `DOCKER_HOST` points
at a remote host over SSH (`ssh://dante`), which the `docker` CLI can reach
via its own built-in SSH tunneling but `dockerode` (the app's Docker client
library) cannot. Set up a local `ssh -L` port-forward to the remote daemon's
socket to get real `dockerode` connectivity for this test — confirmed
working (`DockerConnectionService`/`DockerWatcherService` both connected
live, "docker events stream connected").

**Verified working, live, against the real remote daemon**:

- Server creation → container creation with correct naming (`msm-srv_<id>`),
  labels (`msm.id`, `msm.managed`), and port allocation (sequential
  game/RCON ports assigned correctly across multiple servers).
- Server deletion → container removed cleanly, confirmed via `docker ps -a`
  showing zero `msm.managed` containers after delete.
- The real-data migration test above (separate section) also exercised a
  full create→boot flow against the LEGACY app with this same tunnel, which
  worked end-to-end including a real Minecraft server generating a world —
  confirming the Docker/bind-mount mechanism itself is sound.

**Not achievable in this environment**: a full create→**start**→running
lifecycle test through the NEW backend. `ServerEnvironmentService.ensureOwnership`'s
fast-path reads the panel process's own local view of the server's data
directory (`fs.statSync`) to decide whether a chown container needs to run
at all — correct and intentional for the app's actual deployment model
(panel and Docker daemon sharing one filesystem, documented in
`docs/architecture.md`), but this sandbox's split topology (local panel
process, Docker daemon on a genuinely different machine reached over SSH)
has no shared filesystem, so the bind-mount source path the daemon resolves
`/work/<id>` against is never the same directory the panel just statted.
Confirmed via code review this is a sandbox-topology artifact, not an app
bug: manually replicating `ContainerService.chownDataDir`'s exact `dockerode`
call (same image, entrypoint, bind, `NetworkMode: 'none'`) succeeds cleanly
outside the app's own ownership fast-path logic. Stop/restart/recreate and
crash-detection/auto-restart-backoff were not exercised for the same reason
— they all require a server that actually reached a running state first.

## New capability beyond legacy

Just the one harmless `GET /` scaffold stub noted above. Everything else in
the new backend's 202 routes has a direct legacy ancestor — the rewrite
added no speculative new endpoints beyond what was already documented as
deliberately-new elsewhere in this project (e.g. the WS gateway wire-protocol
change, which isn't an HTTP route and isn't counted here).
