# Shared types

TypeScript interfaces for the JSON shapes the backend API returns and the
frontend consumes. One file per domain, matching `frontend/src/api/*.ts`'s
existing split.

These are **type-only** — every file here is a `.d.ts` with nothing but
`export interface`/`export type` declarations, no runtime code. That's
deliberate, not a style preference:

- The backend (`backend/tsconfig.json`) sets `rootDir: "./src"`, so a plain
  `.ts` file imported from outside `src/` fails the compiler's rootDir check
  (`TS6059`). Declaration files are exempt from that check, so `.d.ts` is
  the only form that imports cleanly into the backend without changing its
  build layout.
- Since these types compile away to nothing (`import type { X } from ...`
  erases completely under `isolatedModules`), there's no runtime dependency
  either side needs to manage — no build step, no package, no workspace
  wiring.

## Usage

Both packages import by relative path — there's no path alias configured,
to keep this working identically under the backend's `nodenext` resolution
and the frontend's `bundler` resolution without relying on two separate
alias configs staying in sync:

```ts
// backend/src/api/server-view-model.service.ts
import type { ServerViewModel } from '../../../shared/types/servers';

// frontend/src/api/servers.ts
import type { ServerViewModel } from '../../../shared/types/servers';
```

## Why this exists

Before this, the exact same response shape was hand-written twice — once
implicitly in whatever a NestJS controller/service returned, once explicitly
in a frontend `interface` with a comment saying "mirrors the backend." A
divergence between the two was a silent runtime bug, not a type error. Now
a controller's declared return type and the frontend's expected response
type are the literal same interface — if the backend's shape drifts, the
backend fails to typecheck; if the frontend expects a field the backend
doesn't send, the frontend fails to typecheck.

## What's migrated so far

Not every domain has been moved into `shared/types/` yet — this was
introduced with a couple of domains proven end-to-end (build + typecheck on
both sides) as the template. Migrating the rest of `frontend/src/api/*.ts`'s
inline interfaces (and the matching backend response types) is mechanical:
move the `export interface`/`export type` declarations here as a `.d.ts`,
delete them from both original locations, import from here instead. Keep
the frontend file's non-type exports (the `xApi = { ... }` object) in
place — only the type declarations move.
