# Agent instructions

Guidance for coding agents (and contributors) working in this repo. Read this first, then:

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — setup, the exact CI gates, code layout, and the two
  non-obvious conventions (path-guarded `./data` access, lazy `require()` cycle-breakers).
- **[docs/architecture.md](docs/architecture.md)** — the new `backend/`/`frontend/` architecture:
  NestJS module/DI structure, layering, `forwardRef()` circular-module cases, boot sequence.
- **[docs/README.md](docs/README.md)** — the user-facing feature docs, if a change touches
  behavior a user would notice.
- **[CHANGELOG.md](CHANGELOG.md)** — Keep a Changelog format; add an entry for user-visible changes.

## Current state: two implementations, one in-flight cutover

This repo is mid-rewrite. **Two complete implementations currently coexist**:

- **`src/` + `views/`** (repo root) — the original single-process Express + Handlebars + raw-`ws`
  app. Strict TypeScript, `tsx`-run with no build step. This is the **pre-rewrite reference
  implementation** — still runnable, still what `npm start`/`npm run dev` at the repo root launch,
  still what the published Docker image builds. Not yet deleted.
- **`backend/` + `frontend/`** — the rewrite target. `backend/` is a NestJS app (own `package.json`,
  own `tsconfig.json`, Nest CLI build); `frontend/` is a Vue 3 + Quasar SPA (own `package.json`,
  Quasar CLI/Vite build). Both are functionally complete: the backend has ~200 HTTP routes across
  ~37 modules plus socket.io WS gateways, and the frontend consumes the API end-to-end. **The final
  cutover has not happened yet** — `src/`/`views/` have not been deleted, the Dockerfile still
  builds the old stack, and the frontend's WS composables (`useConsoleSocket`/`useStatsSocket`)
  still target the OLD raw-`ws` endpoints, not the new backend's socket.io gateways (a required,
  not-yet-done follow-up — see `backend/src/ws/WS_NOTES.md`).

**Know which implementation the code you're touching belongs to.** A bug fix or feature almost
always belongs in `backend/`/`frontend/` now, not `src/`/`views/` — check with whoever's driving
the cutover before investing in the old implementation. Each side has its own conventions:

- **`backend/`** — NestJS, strict TypeScript, dependency injection (constructor injection
  throughout, `forwardRef()` only for genuine circular module dependencies — see
  `docs/architecture.md`'s "Circular module dependencies" section before adding a new one). Each
  domain module has established a `*_NOTES.md` file for non-obvious implementation decisions (e.g.
  `backend/src/db/DRIZZLE_NOTES.md`, `backend/src/servers/SERVERS_NOTES.md`,
  `backend/src/ws/WS_NOTES.md`) — check for one before re-deriving a decision that's already
  documented. No lazy `require()` cycle-breakers here; that convention is `src/`-only (below).
- **`frontend/`** — Vue 3 (Composition API, `<script setup>`, TypeScript), Quasar components
  preferred over custom CSS/components except where Quasar has no equivalent.
- **`src/` (legacy, reference only)** — strict TypeScript, `allowJs: false`, no `@ts-nocheck`. Uses
  `require()` for values and lazy (function-scoped) `require()` as an intentional cycle-breaker —
  see CONTRIBUTING.md. Don't invest new feature work here; it's being superseded.

Treat correctness, security, and data safety on par with feature work in either implementation —
this is meant to be a **production-grade** self-hosted panel, not a hobby script.

## TypeScript & Node style

The rest of this file (through "Other things to hold to") was written for **`src/`**, the
pre-rewrite implementation, and its conventions largely still apply there verbatim. For
**`backend/`**, the same spirit holds (strict types, no `any` escape hatches, async throughout) but
the mechanics differ — see `docs/architecture.md` for the actual pattern: real ES `import`s
throughout (no `require()`-for-values convention), constructor injection instead of lazy-require
cycle-breakers, `forwardRef()` for the rare genuine circular module dependency instead of a
function-scoped `require()`. Don't port `src/`'s lazy-require pattern into `backend/` — Nest's DI
container is the mechanism for exactly what that pattern was working around.

- Prefer `unknown` over `any`; reserve `any` for genuinely dynamic data (NBT parsing, blueprint
  manifests, third-party JSON) — this is the existing convention, enforced as a lint warning, not
  an error, so don't let it silently accumulate.
- Prefer explicit types on public function signatures (service methods, route handlers); let
  inference handle locals.
- No new native-module dependencies without discussion — the "no native modules to compile" story
  (`node:sqlite`, pure-JS deps) is a deliberate zero-friction-install property of this project.
- `src/` only: `import type { ... }` for types, `require()` for values (see CONTRIBUTING's
  cycle-breaker note) — don't convert files to full ESM `import` as a drive-by change.
- Async all the way: no callback-style APIs, no unhandled promise rejections. `src/` route handlers
  must go through `asyncHandler` (see CONTRIBUTING's shared helpers); `backend/` controllers get
  this for free from Nest's request pipeline.

## SOLID, applied pragmatically

Aim for SOLID boundaries. In `backend/`, this is largely just "write idiomatic NestJS" — one
`@Injectable()` per concern, constructor injection, real module boundaries. In `src/`, it's the
Node/service-module sense, not a Java-style class hierarchy:

- **Single responsibility** — one file per domain concern under `services/` (`src/`) or one service
  class per concern (`backend/`); something that's grown multiple unrelated reasons to change
  should be split — see `backend/src/servers/SERVERS_NOTES.md` for a worked example of splitting a
  985-line hub service this way.
- **Open/closed** — the field catalog (`src/config/field-catalog/`) is the model: adding a server
  setting is a data change, not new branching logic scattered through the wizard/forms/validation.
  Favor that pattern (data-driven extension) over new `if`/`switch` branches when adding a variant
  of something that already has several.
- **Liskov / interface segregation** — keep function/method signatures narrow and specific to what
  a caller actually needs, rather than one bloated options object reused everywhere. `src/` uses
  plain functions and modules, not class hierarchies — don't introduce inheritance there. `backend/`
  uses NestJS's `@Injectable()` classes, which is the framework's own idiom, not an exception to
  this rule — keep those classes' public methods narrow too.
- **Dependency inversion** — the layering rule *is* this principle. In `src/`: `services/` depend on
  `docker/`, `db/`, `storage/` through their existing module boundaries, never the reverse, and
  `web/routes/` never reaches into infrastructure directly; no DI container, the directory layering
  does the job. In `backend/`: this is Nest's constructor injection directly — services declare
  their dependencies in the constructor, modules declare `imports`/`exports`, and the same
  controller → service → infrastructure direction holds.

Apply these to justify clean boundaries, not to add abstraction for its own sake: a single
implementation doesn't need an interface, a two-line helper doesn't need a factory. Match the
existing house style — three similar lines beats a premature abstraction.

## Defense-in-depth

Producing a genuinely secure application is a project goal — not just meeting a minimum bar at
the trust boundary. Layer checks (e.g. validate at the route *and* re-validate the invariant
inside the service that acts on it) where doing so meaningfully reduces blast radius if an earlier
layer is ever bypassed or wrong.

**But: if a defense-in-depth change would introduce moderate or significant code complexity —
new abstractions, new cross-cutting checks, new state to keep in sync, meaningfully more branches
or surface area — stop before implementing it.** Do not write the change speculatively "to be
safe." Instead:

1. Describe the specific threat the extra layer defends against, and why the existing layer(s)
   are insufficient for it.
2. Present the complexity trade-off honestly (what gets harder to read/maintain/change).
3. Ask a human developer for explicit guidance and get a clear go-ahead **before** writing the
   code.

A small, local, low-complexity hardening (an added bounds check, a narrowed type, an assertion at
a boundary) doesn't need this — use judgment, but bias toward asking when in doubt. This applies
on top of, not instead of, the existing documented invariants in "Other things to hold to" below:
those are already-decided defense-in-depth and should be preserved as-is without re-litigating
them; this rule is about *adding new* layers, not maintaining current ones.

### Reverse proxy is the deployment boundary

The panel is designed to run **behind a reverse proxy** for anything beyond localhost (see
README's "Do it safely" section — `TRUST_PROXY` / `COOKIE_SECURE` exist for exactly this). TLS
termination / certificate handling, network-level rate limiting, and request payload/body size
limits are the reverse proxy's job, not the app's. Concretely: don't add TLS/cert handling inside
the app, don't add or expand general-purpose rate limiting or body-size-limit logic in `web/` to
compensate for an assumed missing proxy — that's exactly the kind of new defense-in-depth layer
covered above, so if a gap like that seems to need closing in-app, follow the process above
(state the threat, the trade-off, ask first) rather than adding it. This does **not** cover the
existing **login rate-limiting** (shared across the password and 2FA-code steps) — that's an
auth-specific, already-decided invariant like the ones in "Other things to hold to," not a
network-layer concern the proxy can substitute for.

## Other things to hold to

- **Security boundaries are load-bearing, not incidental**: the path guard (`safeJoin`), the SSRF
  guard on server-side downloads, secret encryption at rest, and RCON never being exposed outside
  the container are documented invariants (see README's Security section) — changes that touch
  file paths, outbound URLs, or secrets must preserve them, not route around them for convenience.
- **Docker is the only container interface** — talk to it through `dockerode` (`src/docker/` or
  `backend/src/docker/`), never by shelling out to the `docker` CLI.
- **Tests**: `src/`'s `npm test` must stay Docker-free and fast (`node:test`, no real containers).
  Anything needing a live daemon belongs in the separate `npm run test:smoke` sweep, not the unit
  suite. `backend/` has no real test suite yet (just the unedited Nest CLI scaffold's
  `app.controller.spec.ts`) — this rewrite was verified by building, booting the real app against a
  scratch data directory, and exercising it live with `curl`/a socket.io client for every module,
  not by an automated suite; writing real `*.spec.ts` coverage (per the original rewrite plan's Nest
  `@nestjs/testing` + `node:test` strategy) is still open work.
- **Don't add speculative configuration or feature flags.** This project favors sane, host-aware
  defaults (see README's `.env` table) over exposing every knob — only add an env var if there's a
  concrete case where the default is wrong for a real setup.
