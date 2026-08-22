# Agent instructions

Guidance for coding agents (and contributors) working in this repo. Read this first, then:

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — setup, the exact CI gates, code layout, and the two
  non-obvious conventions (path-guarded `./data` access, lazy `require()` cycle-breakers).
- **[docs/architecture.md](docs/architecture.md)** — runtime shape, layering, key domain behaviors,
  boot sequence.
- **[docs/README.md](docs/README.md)** — the user-facing feature docs, if a change touches
  behavior a user would notice.
- **[CHANGELOG.md](CHANGELOG.md)** — Keep a Changelog format; add an entry for user-visible changes.

## Project goals

This is meant to be a **production-grade** self-hosted panel, not a hobby script — treat
correctness, security, and data safety on par with feature work. Two migrations are in flight;
know which one applies to the code you're touching:

- **Backend (`src/`) is strict TypeScript**, fully converted (`allowJs: false`, no `@ts-nocheck`
  escape hatch). Write idiomatic, strictly-typed TS — no loosening the gate with `any` to make
  something compile. See [CONTRIBUTING.md](CONTRIBUTING.md) for the exact typecheck command.
- **Frontend is mid-migration to Vue**, away from server-rendered Handlebars + hand-written
  `public/js/`. Don't invest in new Handlebars/vanilla-JS UI without checking whether that surface
  is already scoped for the rewrite. New frontend code should be written as idiomatic Vue 3
  (Composition API, `<script setup>`, TypeScript) once that work starts in a given area.

## TypeScript & Node style

- Prefer `unknown` over `any`; reserve `any` for genuinely dynamic data (NBT parsing, blueprint
  manifests, third-party JSON) — this is the existing convention, enforced as a lint warning, not
  an error, so don't let it silently accumulate.
- Prefer explicit types on public function signatures (service methods, route handlers); let
  inference handle locals.
- No new native-module dependencies without discussion — the "no native modules to compile" story
  (`node:sqlite`, pure-JS deps) is a deliberate zero-friction-install property of this project.
- Follow the existing module convention: `import type { ... }` for types, `require()` for values
  (see CONTRIBUTING's cycle-breaker note) — don't convert files to full ESM `import` as a drive-by
  change.
- Async all the way: no callback-style APIs, no unhandled promise rejections. Route handlers must
  go through `asyncHandler` (see CONTRIBUTING's shared helpers).

## SOLID, applied pragmatically

Aim for SOLID boundaries, but in the Node/service-module sense, not a Java-style class hierarchy:

- **Single responsibility** — one file per domain concern under `services/`; a service that's
  grown multiple unrelated reasons to change should be split.
- **Open/closed** — the field catalog (`src/config/field-catalog/`) is the model: adding a server
  setting is a data change, not new branching logic scattered through the wizard/forms/validation.
  Favor that pattern (data-driven extension) over new `if`/`switch` branches when adding a variant
  of something that already has several.
- **Liskov / interface segregation** — keep function signatures narrow and specific to what a
  caller actually needs, rather than one bloated options object reused everywhere. This codebase
  uses plain functions and modules, not class hierarchies — don't introduce inheritance or class
  hierarchies to satisfy this principle; narrow types and small function signatures accomplish the
  same goal.
- **Dependency inversion** — the layering rule *is* this principle: `services/` depend on
  `docker/`, `db/`, `storage/` through their existing module boundaries, never the reverse, and
  `web/routes/` never reaches into infrastructure directly. Don't add a DI container or interface
  layer to enforce this — the directory layering already does the job; keep new code inside it.

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
- **Docker is the only container interface** — talk to it through `dockerode` (`src/docker/`),
  never by shelling out to the `docker` CLI.
- **Tests**: `npm test` must stay Docker-free and fast (`node:test`, no real containers). Anything
  needing a live daemon belongs in the separate `npm run test:smoke` sweep, not the unit suite.
- **Don't add speculative configuration or feature flags.** This project favors sane, host-aware
  defaults (see README's `.env` table) over exposing every knob — only add an env var if there's a
  concrete case where the default is wrong for a real setup.
