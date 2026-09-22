# API tokens module notes

Non-obvious implementation decisions for `backend/src/api-tokens/`. See `AGENTS.md` at the repo
root for when to check this file vs. re-deriving a decision from scratch. Ports upstream parity
item 3.17 ("public read-only API") — read upstream's `services/apiTokens.js` /
`web/routes/apiV1.js` / `web/middleware/bearer.js` for _behavior_, not code; this is a from-scratch
NestJS implementation over our own dual-dialect Drizzle schema and guard stack, not a port of
upstream's Express middleware.

## What this ships

- `GET /api/v1/servers` — the servers a token is scoped to, with an online/offline summary count.
- `GET /api/v1/servers/:id` — one server's detail, 404 if outside the token's scope.
- Admin-only management API at `/api/api-tokens` (list, create, revoke, and the on/off toggle).
- A Settings → Public API admin UI (`frontend/src/pages/ApiTokensPage.vue`).

## Token storage: hash, never the raw value

`api_tokens.token_hash` is a sha256 hex digest of the raw token (`ApiTokensService.hashToken()`).
The raw value (`cow_pat_<32 random bytes, base64url>`) is generated at mint time, returned once in
`create()`'s response, and never persisted or logged anywhere else — same shape as how a password
hash works, not reversible encryption (unlike `SecretsService`'s AES-256-GCM for _outbound_
third-party keys, which must be decryptable to be presented to CurseForge; a Bearer token the panel
itself issues never needs to be re-derived, only compared). sha256 (not bcrypt/argon2) is
appropriate here specifically because the token is already a full-entropy random value, not a
user-chosen password — there's no offline-guessing risk a slow hash would mitigate, and a fast hash
keeps every `/api/v1/*` request cheap.

## Scoping model: `server_ids_json`, not a join table

Unlike `user_server_permissions` (per-`(user, server)` row, one capability list per pair), a token's
scope is a single column on its own row: `server_ids_json = null` means "every server," a JSON array
means "exactly these ids." This is deliberately simpler than the permissions model — a token has no
capability list (it's read-only by construction, nothing to grant beyond visibility) and no role
tiers, so there's no matrix to represent, just a set membership check
(`ApiTokensService.canSeeServer()` / `visibleServerIds()`). `create()` validates every listed id
exists (and isn't soft-deleted) at mint time so an admin can't accidentally scope a token to a typo'd
id and have it silently see nothing forever.

## Hidden-vs-404, reused from the permissions module

`GET /api/v1/servers/:id` for a server outside the token's scope answers 404, the same
hidden-vs-404 contract `PERMISSIONS_NOTES.md` documents for user-scoped routes — a probing caller
can't distinguish "wrong id" from "real id, not in your scope." `GET /api/v1/servers` simply omits
out-of-scope servers from the list, matching `visibleServerIds()`'s fleet-list precedent.

## `OriginGuard` bypass: `@SkipOriginCheck()`

`AUTH_NOTES.md`'s "Guard scoping: no Bearer/API-key bypass needed (yet)" section flagged this
feature by name and named two options: a decorator checked like `@Public()`, or an explicit
`req`-shape check for a validated Bearer principal. This went with the decorator
(`auth/skip-origin-check.decorator.ts`), applied on `PublicApiController` next to `@Public()` and
`@UseGuards(BearerAuthGuard)` — consistent with how `@Public()`/`SessionAuthGuard` already work,
and `OriginGuard` only needed one `Reflector.getAllAndOverride` check added, not new state.

In practice this is close to a no-op today: both public-API routes are `GET`, and `OriginGuard`
already lets every `GET`/`HEAD`/`OPTIONS` through unconditionally regardless of Origin. The
decorator exists so that stays true on purpose, not by accident, if a future public-API route is
ever non-`GET` — Bearer tokens aren't CSRF-exposed the way a cookie is (nothing auto-attaches an
`Authorization` header to a cross-site request), so exempting them is correct even then, not just
currently harmless.

## Rate limiting: mirrors `LoginRateLimitService`, doesn't extend it

`AGENTS.md` calls out login rate-limiting as an existing, already-decided invariant to reuse/mirror
rather than build fresh. `LoginRateLimitService` itself wasn't reusable as-is: it's a
failure-lockout counter (N wrong passwords → locked for a window), and `/api/v1/*` needs a
request-volume throttle (N requests total → throttled for a window) — a different trigger condition
on the same primitive shape. `ApiRateLimitService` copies the shape that _does_ transfer: an
in-memory `Map<string, ...>` keyed by subject, bounded at `MAX_TRACKED` with an evict-oldest-quarter
policy so an unbounded key space (rotating tokens, spoofed IPs) can't grow it forever — same
numbers, same eviction strategy as `LoginRateLimitService`. `BearerAuthGuard.canActivate()` checks
it twice per request, `ip:<req.ip>` first (so a burst of _invalid_ tokens from one address is still
throttled before a token is even resolved) and `token:<tokenId>` second (once the token is known) —
mirrors the login limiter's own per-IP-then-per-subject ordering.

## Off by default: a `settings` row, not an env var

Per AGENTS.md's "don't add speculative configuration" rule and the existing `SettingsService`
precedent (`getStartingPort`/`setStartingPort`, `getPublicHost`/`setPublicHost`, etc. — all
DB-backed key/value rows via `settings.get`/`settings.set`, not `.env` knobs), the feature toggle is
a `settings` row (`public_api_enabled`, boolean, default `false`) rather than a new env var.
`ApiTokensService.isEnabled()`/`setEnabled()` follow that same generic `get`/`set` pattern used
throughout `SettingsService` rather than adding a dedicated column anywhere — `resolve()` checks it
first, before even hashing the presented token, so a disabled panel rejects every Bearer request
uniformly (same 401 as an unknown token) without leaking whether the feature exists.

## Guard placement: route-scoped, not `APP_GUARD`

`BearerAuthGuard` is applied via `@UseGuards(BearerAuthGuard)` on `PublicApiController` only —
same reasoning as `ServerPermissionGuard` (see `PERMISSIONS_NOTES.md`'s "The guard + decorator"
section): a guard that only concerns one slice of routes doesn't need global registration, and
`/api/v1/*` is `@Public()` specifically so the cookie-session guards (`SessionAuthGuard`,
`WriteGuard`) don't run at all for it — `BearerAuthGuard` is a full replacement authentication
layer for that one controller, not an addition alongside them.

## `route-audit.spec.ts`: `EXCLUDE_ROSTER`

`PermissionsModule`'s structural test flags any route shaped `.../servers/:id` as needing
`@RequireServerPermission` + `ServerPermissionGuard`. `GET /api/v1/servers/:id` matches that shape
but isn't `req.user`/`user_server_permissions`-scoped at all (`@Public()` routes never populate
`req.user`) — it's scoped by the token's own `server_ids_json` grant instead, checked directly in
`PublicApiController#get`. Added a one-line `EXCLUDE_ROSTER` set to `route-audit.spec.ts` (the
audit's existing `EXPLICIT_ROSTER` only ever _adds_ cases the path heuristic misses; this is the
first case the heuristic wrongly catches) so the exception is reviewer-visible in the same file,
rather than silently weakening the path heuristic itself.
