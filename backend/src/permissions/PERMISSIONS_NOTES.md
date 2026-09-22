# Permissions module notes

Non-obvious implementation decisions for `backend/src/permissions/`. See `AGENTS.md` at the repo
root for when to check this file vs. re-deriving a decision from scratch. Ports upstream parity
item 3.16 (per-server permissions) — read for _behavior_, not code; this is a from-scratch NestJS
implementation over our own dual-dialect Drizzle schema, not a port of upstream's Express
middleware.

## Model

- **Nine capabilities**, in catalog order: `view`, `power`, `console`, `players`, `content`,
  `backups`, `files`, `settings`, `delete` (`PermissionsService.CAPABILITIES`). `view` is implied
  by every other capability — `normalize()` adds it automatically — because you can't meaningfully
  act on a server you can't see.
- **Global role is the default** on every server: `admin` and `operator` both default to every
  capability, `viewer` defaults to `view` only (`ROLE_DEFAULTS`).
- **Admin is never overridden.** `PermissionsService.effective()` short-circuits to every
  capability for `role === 'admin'` before ever looking at `user_server_permissions` — there is no
  way to hide a server from, or restrict, an admin account via a per-server grant. If you need a
  restricted admin, change their role to `operator` and grant explicitly.
- **A row in `user_server_permissions` replaces the role default** for one (user, server) pair —
  it's an override, not an addition. The table already existed in the schema (`backend/src/db/schema/users.ts`
  and `schema-pg/users.ts`), unreferenced until this change; its shape (`userId`, `serverId`,
  `perms` as a free-text column, composite primary key, `onDelete: 'cascade'` from `users`) needed
  no migration — `perms` stores a JSON array of capability names (`PermissionsService`'s
  `parseStored()` also accepts a legacy comma-separated form defensively, matching the column's
  `default('view')` seed value, though nothing in this codebase ever wrote that form).
  `perms: '[]'` (empty array) means the server is **hidden** from that user entirely — it is a
  real, meaningful state, not "no grant" (a missing row means "use the role default" instead).

## Admin/operator bypass, consistency with `RolesGuard`

`RolesGuard` (`backend/src/auth/guards/roles.guard.ts`, from PR #41) is the precedent this follows:
route-scoped, `@UseGuards(...)` + a decorator (`@Roles`/`@RequireServerPermission`), reading
`req.user` populated earlier by the global `SessionAuthGuard`. `ServerPermissionGuard` doesn't
replace `RolesGuard` — routes that were already admin/operator-only (e.g. `backups/:backupId/download`)
keep `@Roles('admin', 'operator')` _and_ gain `@RequireServerPermission(...)`, because an operator's
role default is "every capability" but an explicit per-server grant can still narrow or hide a
_specific_ server for that operator. `@Roles` alone can't express that; only `ServerPermissionGuard`
consulting `user_server_permissions` can.

## Hidden-vs-404, not hidden-vs-403

A server the caller may not `view` answers **404**, indistinguishable from a server that never
existed — never 403. `ServerPermissionGuard.canActivate()` does an existence-only lookup first
(`SELECT id FROM servers WHERE id = ?`, no `deletedAt` filter — soft-deleted servers can still be
permission-checked, matching `visibleServerIds()`'s soft-delete note below); if no row matches, the
guard calls `next()` unconditionally and lets the handler's own not-found logic run — the same
404 a real caller would get for a made-up id. If a row _is_ found but the caller lacks `view`, the
guard throws `NotFoundException` directly. Both paths converge on the same response shape, so a
probing request can't distinguish "doesn't exist" from "exists but hidden from you." Only once
`view` passes does the guard check the actual capability, which — if missing — is a `403`
(`ForbiddenException`): at that point the server's existence is already established for this
caller (they can see it), so there's nothing left to protect by hiding the reason.

The same hidden-vs-404 contract applies to WebSocket connections: `gateway-auth.ts`'s
`authenticateGatewayConnection()` now also checks `permissions.can(user, serverId, 'view')` after
the existing session/server-existence checks, and a failure disconnects the client exactly the same
way (`client.disconnect(true)`, no payload) as every other failure in that function already did —
see `WS_NOTES.md` for the rest of that function's checks (origin, session).

### Fleet-wide list endpoints

A server the caller can't view must also be absent from every list, not just blocked when named
directly. `PermissionsService.visibleServerIds()`/`filterVisible()` are the shared primitive for
this — every fleet-wide endpoint that returns servers, or rows that name a server, filters through
one of them: `ServersController#list`/`#live`, `BackupsController#listAll`,
`SchedulesController#list`, `EventsController#list` (a hidden server's events, but _not_
panel-global events with `serverId = null`, which stay visible to everyone), and
`TasksController#list`/`#get` (a running task naming a hidden server 404s the same as an unknown
task id).

`visibleServerIds()` includes **soft-deleted** servers in its universe on purpose: a server hidden
from someone stays hidden in their history and kept backups after it's deleted, and — symmetrically
— someone who could view it keeps seeing it in history afterward. This mirrors upstream's own
documented choice (`services/permissions.js`'s `visibleServerIds` comment) and is the reason the
guard's existence check above also doesn't filter on `deletedAt`.

## The guard + decorator

- `@RequireServerPermission(capability, resolve?)` (`require-server-permission.decorator.ts`) sets
  route metadata; `ServerPermissionGuard` (`server-permission.guard.ts`) reads it via `Reflector`
  and enforces it. Applied per-route (`@UseGuards(ServerPermissionGuard)` + the decorator), same
  pattern as `RolesGuard`/`@Roles` — not a global `APP_GUARD`, because the capability differs per
  route and a route with no `@RequireServerPermission` metadata is simply not this guard's concern
  (that's what the structural test below is for).
- **Default server-id resolution** is `req.params.id` — true for the large majority of server-scoped
  controllers, which are mounted at `api/servers/:id/...`.
- **`resolve`** is an escape hatch for the routes where the server id isn't the handler's own `:id`
  param: a backup id → its owning server (`backupServerId` in `backups.controller.ts`), a schedule
  id → its `serverId` column (`scheduleServerId` in `schedules.controller.ts`), or a request body
  field (`blueprints.controller.ts`'s `export`/`clone`, `worlds.controller.ts`'s fleet-level
  `extract`/`install`). `resolve` receives `(req, { db })` — not just `req` — because these
  resolvers run as plain functions attached via `SetMetadata` at class-definition time, before any
  controller instance (and its constructor-injected services) exists; `db` is `ServerPermissionGuard`'s
  own `DbService`, handed through so a resolver can do a one-table lookup without its own DI wiring.

## Known scope boundaries (not gold-plated)

Deliberately **not** covered, to stay within the prompt's described scope rather than chase every
edge case upstream's own multi-round review (`f3e0b63`, `0dc57cf`, `1484328`) eventually closed:

- **A second server named only in a request body** where the primary server is already checked via
  path param — e.g. `ServerWorldsController#copyTo`'s `targetServerId` (the _source_ `:id` is
  guarded with `content`, but the target server's permission isn't independently checked). The
  guard only supports one capability check against one resolved server id per route today;
  supporting two would mean a new decorator shape (`RequireServerPermission` taking a _list_ of
  `[capability, resolve]` pairs) — a real cross-cutting change, not a one-line addition, so it's
  flagged here rather than built speculatively. If this needs closing, it should go through
  AGENTS.md's defense-in-depth ask-first process.
- **Schedules use one capability (`power`) for every task type**, unlike upstream's finer-grained
  mapping (`power` for start/stop/restart, `console` for RCON, `backups` for backup schedules).
  Matching that would mean resolving the capability dynamically from the request body's `taskType`
  field — again a new resolver shape the decorator doesn't support today (it names one static
  capability per route). Scheduling anything is power-user territory regardless of task type, so a
  single `power` gate was judged an acceptable simplification rather than new decorator surface.
- **Blueprint list/import/delete and world-library rename/delete/PATCH-by-id** are not
  server-permission-gated — a blueprint or library-world _entity_ isn't 1:1 with a specific live
  server the way a backup or schedule row is (a blueprint can outlive the server it was exported
  from; a library world can be installed to any server). Only `export`/`clone` (which name a
  _source_ server explicitly) and the fleet `extract`/`install` (which name a source/target server)
  are gated.
- **Tasks** (`TasksController`) stay behind the pre-existing `@Roles('admin', 'operator')` class
  gate (viewers never reach it at all) plus the `visibleServerIds()` filtering described above —
  it does _not_ get `ServerPermissionGuard`/`@RequireServerPermission`, because a task isn't a
  route acting on `:id` at all (its id is the task id, and its `serverId` is metadata on the task
  object, not resolvable the way a backup/schedule row is via a simple lookup).

## The structural test (`route-audit.spec.ts`)

Parses every `backend/src/**/*.controller.ts` file **as TypeScript source** (`typescript`'s
`createSourceFile`/AST, not `require()`) and, for every route whose full path acts on a specific
server, asserts it carries both `@RequireServerPermission(...)` and a `ServerPermissionGuard` in
its (class- or method-level) `@UseGuards(...)`.

**Why source parsing, not `require()`-and-reflect**: an earlier version of this test tried to
`require()` each controller file and read `@nestjs/common`'s own `Reflect` metadata off the live
class — closer to what Nest itself does at boot. It broke immediately: several controllers
transitively import ESM-only packages (`sanitize-html` → `htmlparser2`), which jest's CJS
transform can't load just to inspect decorators, and a private class getter (`private get db()`)
on `Object.getOwnPropertyNames(prototype)` executes when read off the bare prototype with no
instance/DI behind it, throwing. Parsing the source text sidesteps both: nothing is ever executed,
only decorator call expressions are inspected.

**Two detection strategies**, combined:

1. **Path-based** (`actsOnServerByPath()`): any route whose joined path (class `@Controller()`
   prefix + method decorator argument) has a `servers` segment immediately followed by a `:param`
   segment. Covers the large majority of routes automatically — add a new method to an existing
   `api/servers/:id/...` controller (or a new controller mounted there) and the test finds it with
   no roster update needed.
2. **`EXPLICIT_ROSTER`**: an explicit `ClassName#methodName` list for the resolver-based routes
   from the section above, which the path heuristic can't find (their server id lives in a
   different id's lookup or a request body, not a `:id` path segment). A new route of this shape
   needs one line added here — the point of an explicit, reviewable list rather than a broader
   heuristic that might overreach and demand the guard on genuinely unrelated routes.

Run it on its own: `cd backend && npx jest permissions/route-audit`.
