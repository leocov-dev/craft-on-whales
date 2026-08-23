# Contributing

Thanks for your interest in improving Minecraft Server Manager. The project is mid-rewrite: the
active codebase is two packages, **[`backend/`](backend/README.md)** (NestJS, strict TypeScript)
and **[`frontend/`](frontend/README.md)** (Vue 3 + Quasar). The original single-process app
(`src/` + `views/`, Express + Handlebars) still exists at the repo root as a reference until final
cutover — new feature work belongs in `backend/`/`frontend/`, not there. See
[AGENTS.md](AGENTS.md) for the full picture of that transition.

## Getting set up

Run the backend and frontend as two separate dev servers:

```bash
cd backend
npm install
npm run start:dev   # NestJS, auto-restart on change — http://localhost:3000
```

```bash
cd frontend
npm install
npm run dev          # Quasar/Vite dev server with HMR, proxies /api and /ws to the backend
```

You need **Node.js 24+** (for the flagless built-in `node:sqlite`) and Docker running to exercise
anything that touches containers. First run creates the admin account.

All backend state lives under `./data` (or `$DATA_DIR`, resolved relative to the repo root). To
start from a clean slate, stop the backend and delete that directory — it's rebuilt on boot.

## Before you open a PR

Backend:

```bash
cd backend
npm run lint        # ESLint
npx tsc --noEmit -p tsconfig.json    # strict typecheck, no emit
npm run build        # nest build
```

Frontend:

```bash
cd frontend
npm run lint:check   # Prettier + ESLint, no fixes
npm run typecheck    # vue-tsc --noEmit
npm run build         # quasar build
```

Keep changes focused and match the surrounding style (Prettier enforces it in both packages).
Both packages are **strict TypeScript** — new code should be typed properly, not loosened with
`any` to get a gate to pass.

## How the code is organized

The full picture is in [`docs/architecture.md`](docs/architecture.md). The short version, for
`backend/`:

**Layering — one direction only:**

```
controllers (HTTP)  →  services (domain logic)  →  docker / db / storage (infrastructure)
```

- **Controllers** — one (or a few) per domain module. Parse/validate input (zod), call an injected
  service, shape the response. No business logic here.
- **Services** — `@Injectable()` classes, the domain logic. This is where features live. Services
  depend on other services and on infrastructure through NestJS constructor injection, declared in
  each module's `imports`/`providers`.
- **`docker/`, `db/`, `storage/`** — infrastructure. `docker/` wraps dockerode; `db/` wraps Drizzle
  ORM over `node:sqlite` + migrations; `storage/` owns the `./data` layout, the path guard, and
  disk quotas.
- **`config/`** holds `ConfigService` (env resolution). The field-catalog concept from the legacy
  app (every itzg environment variable with friendly label/help/validation, driving the wizard and
  settings forms automatically) still lives in `src/config/field-catalog/` pending its own port.
- **`events/`** is cross-cutting: `EventsService.recordEvent()` is the one entry point for history.
  **`ws/`** carries the live console + stats sockets over socket.io.

`frontend/` mirrors this on the client: `src/api/*.ts` (one module per backend domain, wrapping a
shared `http.ts` fetch instance), Pinia stores for cross-cutting state (`stores/auth.ts`,
`stores/servers.ts`, …), and pages/components organized by route.

## Conventions that will surprise you

1. **Never touch the filesystem under `./data` directly.** Always resolve paths through
   `PathGuardService` (`backend/src/storage/path-guard.service.ts`, `safeJoin`). It rejects any path
   that escapes the data root, which is the backbone of the app's file-safety story. Uploads and
   archive extraction are additionally size-capped.
2. **`forwardRef()` marks a genuine circular module dependency, not a mistake.** A handful of
   modules (`ServersModule`↔`SchedulerModule`, `ServersModule`↔`MapModule`, and a few more) have a
   real bidirectional relationship — see `docs/architecture.md`'s "Circular module dependencies"
   section before adding a new one or "simplifying" an existing one.
3. **Check for a `*_NOTES.md` before re-deriving a design decision.** Several `backend/src/*/`
   directories have one (e.g. `db/DRIZZLE_NOTES.md`, `servers/SERVERS_NOTES.md`, `ws/WS_NOTES.md`)
   documenting a non-obvious choice or a gotcha that was already worked out.
4. **`src/` (legacy) still uses lazy `require()` cycle-breakers** — some modules `require()` a
   sibling _inside a function_ to avoid a circular dependency at load time. If you're touching that
   code and see `const x = require('...')` mid-function, that's why — don't "clean it up" by
   hoisting it without checking for the cycle. This convention does not apply to `backend/`, which
   uses `forwardRef()` instead (above).

## Reporting bugs / requesting features

Open an issue with clear reproduction steps (and your OS + Docker flavor for anything
environment-specific). Security issues: please report privately rather than in a public issue.
