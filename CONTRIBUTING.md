# Contributing

Thanks for your interest in improving Minecraft Server Manager. The codebase is two packages,
**[`backend/`](backend/README.md)** (NestJS, strict TypeScript) and
**[`frontend/`](frontend/README.md)** (Vue 3 + Quasar). See [AGENTS.md](AGENTS.md) for the
project-wide conventions.

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

The backend's port defaults to 3000 but is fully driven by the `PANEL_PORT` env var
(`backend/src/config/config.service.ts`); the frontend dev proxy's backend target follows the
`BACKEND_PORT` env var (`frontend/quasar.config.ts`), defaulting to 3000 to match. To run both on a
different port (e.g. because 3000 is already in use), set both consistently:

```bash
PANEL_PORT=3100 npm run start:dev      # in backend/
BACKEND_PORT=3100 npm run dev          # in frontend/
```

**Coding agents testing the server should not bind port 3000** unless the user explicitly asks for
it — pick another port via `PANEL_PORT`/`BACKEND_PORT` so you don't collide with a server the user
may already have running there. See [AGENTS.md](AGENTS.md).

You need **Node.js 24+** (for the flagless built-in `node:sqlite`) and Docker running to exercise
anything that touches containers. First run creates the admin account.

All backend state lives under `./data` (or `$DATA_DIR`, resolved relative to the repo root). To
start from a clean slate, stop the backend and delete that directory — it's rebuilt on boot.

## Before you open a PR

Root (CI also runs these over the whole repo):

```bash
npm run lint          # ESLint over tools/, eslint.config.js
npm run format:check   # Prettier --check over the whole tree
```

Backend:

```bash
cd backend
npm run lint        # ESLint
npx tsc --noEmit -p tsconfig.json    # strict typecheck, no emit
npm run test          # node:test — currently just the unedited Nest CLI scaffold spec
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
- **`config/`** holds `ConfigService` (env resolution) and `ResourceDefaultsResolver` (host-aware
  heap/memory/disk defaults). The pre-rewrite app's field-catalog concept (every itzg environment
  variable with friendly label/help/validation, driving Simple/Advanced wizard forms
  automatically) has not been ported — the current wizard only covers name/type/version/resources.
  See README's "Status & areas that need work".
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
   modules (`ServersModule`↔`SchedulerModule`, `ServersModule`↔`MapModule`, and several more that
   cascade from those) have a real bidirectional relationship — see `docs/architecture.md`'s
   "Circular module dependencies" section before adding a new one or "simplifying" an existing one.
3. **Check for a `*_NOTES.md` before re-deriving a design decision.** Several `backend/src/*/`
   directories have one (e.g. `db/DRIZZLE_NOTES.md`, `servers/SERVERS_NOTES.md`, `ws/WS_NOTES.md`,
   `docker/DOCKER_NOTES.md`, `api/API_NOTES.md`, `worlds/WORLDS_NOTES.md`) documenting a
   non-obvious choice or a gotcha that was already worked out.

## Reporting bugs / requesting features

Open an issue with clear reproduction steps (and your OS + Docker flavor for anything
environment-specific). Security issues: please report privately rather than in a public issue.
