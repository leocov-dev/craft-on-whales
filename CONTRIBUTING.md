# Contributing

Thanks for your interest in improving Minecraft Server Manager. The backend (`src/`) is **strict
TypeScript**, compiled at type-check time only (`tsx` runs it directly, no emit step). The frontend
is currently server-rendered Handlebars + hand-written browser JS, and is **in the process of
migrating to Vue** — see [Frontend](#frontend) below before starting client-side work.

## Getting set up

```bash
npm install
npm run dev        # starts the app with auto-restart + Tailwind CSS watch
```

Open http://localhost:25564. You need **Node.js 24+** (for the flagless built-in `node:sqlite`) and
Docker running to exercise anything that touches containers. First run creates the admin account.

All state lives under `./data` (or `$DATA_DIR`). To start from a clean slate, stop the app and delete
that directory — it's rebuilt on boot.

## Before you open a PR

These are the exact gates CI runs — each works on a clean clone with no Docker or running app:

```bash
npm run lint          # ESLint (errors, no warnings)
npm run format:check  # Prettier
npm run typecheck     # tsc -p tsconfig.json — strict, over all of src/
npm test              # unit tests (node:test)
npm run build         # CSS build
```

`npm run format` fixes formatting. `npm test` is a real, fast unit suite (no Docker); `npm run
test:smoke` is the separate live sweep against a running panel.

Keep changes focused and match the surrounding style (Prettier enforces it). `src/` is **strict
TypeScript** (`allowJs: false`) — every file is `.ts` and fully type-checked, there's no JS/JSDoc
fallback and no `@ts-nocheck` escape hatch. `types/globals.d.ts` holds ambient augmentations for
untyped third-party surfaces. New code should be typed properly, not loosened with `any` to get a
gate to pass.

`public/vendor/chart.umd.js` is a **vendored** copy of Chart.js (not an npm dependency) — update it by
hand and note the version in the PR.

## How the code is organized

The full picture is in [`docs/architecture.md`](docs/architecture.md). The short version:

**Layering — one direction only:**

```
web/routes (HTTP)  →  services (domain logic)  →  docker / db / storage (infrastructure)
```

- **`web/routes/`** — Express routers. Parse/validate input (zod), call a service, shape the
  response. No business logic here.
- **`services/`** — the domain logic. This is where features live. Services may call `docker/`,
  `db/`, `storage/`, and each other.
- **`docker/`, `db/`, `storage/`** — infrastructure. `docker/` wraps dockerode; `db/` wraps
  `node:sqlite` + migrations; `storage/` owns the `./data` layout, the path guard, and disk quotas.
- **`config/field-catalog/`** is the **single source of truth** for server settings — every itzg
  environment variable, its friendly label, help text, type, default, and validation. Add a server
  setting here and the wizard/forms/validation pick it up automatically.
- **`events/`** and **`ws/`** are cross-cutting: `recordEvent()` is the one entry point for history,
  and `ws/` carries the live console + stats sockets.

## Two conventions that will surprise you

1. **Never touch the filesystem under `./data` directly.** Always resolve paths through the path
   guard in `src/storage/` (`safeJoin`). It rejects any path that escapes the data root, which is the
   backbone of the app's file-safety story. Uploads and archive extraction are additionally
   size-capped.
2. **Lazy `require()` calls are intentional cycle-breakers.** Some modules `require()` a sibling
   _inside a function_ rather than at the top of the file to avoid a circular dependency at load
   time. If you see `const x = require('...')` mid-function, that's why — don't "clean it up" by
   hoisting it without checking for the cycle.

## Shared helpers

Prefer the shared helpers over re-implementing patterns:

- `src/utils/httpError.ts` — `httpError(status, message)` for throwing HTTP errors from services.
- `src/web/middleware/jsonErrorHandler.ts` — the standard JSON error handler (redacts 5xx detail).
- `src/web/middleware/asyncHandler.ts` — wraps async route handlers so rejections reach the error
  handler. Prefer it over hand-written `try/catch → next(err)`.

## Frontend

Views are still server-rendered **Handlebars** (`views/`), with hand-written browser JS in
`public/js/` progressively enhancing them — no client bundler yet. This is actively being migrated
to **Vue**; if you're picking up frontend work, check for an open tracking issue / in-progress
branch before starting new Handlebars-based UI, since it may be scoped for the rewrite instead of
incremental patching. Backend API shape (`web/routes/`) is not expected to change for this
migration — it's a view-layer swap.

## Reporting bugs / requesting features

Open an issue with clear reproduction steps (and your OS + Docker flavor for anything
environment-specific). Security issues: please report privately rather than in a public issue.
