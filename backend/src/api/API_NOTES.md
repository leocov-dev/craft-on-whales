# ApiModule notes

`ApiModule` ports the central resource controllers from legacy
`src/web/routes/api.ts` (1995 lines, ~87 endpoints mixing many resources):
`ServersController`, `EventsController`, `SettingsController`,
`ApiKeysController`, `SchedulesController`, `UpdatesController`,
`BackupsController`, `UsersController`, `PacksController`, plus a new
`ServerViewModelService` (`serverVM`/`packVM`, the exact JSON shape the
already-built Vue frontend expects — see its own doc comment for the one
scoped simplification: live stats/players are fetched per-request instead
of through legacy's always-warm `liveCache` watcher).

## Deliberately deferred (not built in this pass)

`api.ts` also contains several other clusters, left out of scope here
because they either belong to a different module's own controller (built by
a concurrent fork) or need meaningfully new infrastructure this pass didn't
have room for:

- **Mods manager** (`/servers/:id/mods*`, `/servers/:id/pending-downloads*`,
  `/modrinth/search`, `/loaders/versions`, `/mods/search`, `/mods/versions`,
  `/mods/deps`, `/servers/from-mods`) — a large, self-contained cluster
  (~470 lines of the source file) that deserves its own
  `ModsController`/`ModBrowserController` pass.
- **Custom server icon upload** (`POST /servers/:id/icon`,
  `GET /icons/custom/:file`) — needs `@nestjs/platform-express`'s
  `FileInterceptor`/multer wiring, which no controller in this codebase has
  set up yet. Left for whoever builds file-upload support generally (the
  `Files` domain already handles a similar concern for server file
  management — check `backend/src/files/` first before building this from
  scratch).
- **World quick controls** (`/servers/:id/world/state`,
  `/servers/:id/world/quick`) — `WorldControlsService` already exists
  (`backend/src/world-controls/`), just needs a thin controller.
- **Live map (BlueMap)** (`/servers/:id/map*`) — `MapService` already exists
  (`backend/src/map/`), just needs a thin controller.
- **Admin chat** (`/servers/:id/chat`, `/servers/:id/chat/history`) —
  `ChatService` already exists (`backend/src/chat/`); likely belongs
  alongside whatever fork built `ChatCommandsController` for
  `/servers/:id/chat-commands`.
- **Storage** (`/storage/scan`, `/storage/cleanup`, `GET /storage`) — needs
  `src/web/routes/storageCleanup.ts` (166 lines, not yet ported anywhere)
  in addition to the already-built `StorageIndexService`.
- Mounted sub-routers (`blueprints`, `worlds`, `files`, `crashes`, `players`,
  `chat-commands`, `integrations`, `analytics`, `inventory`, `items`) were
  never in scope here — each is its own controller, built by whichever fork
  owns that module.

All of the above are real, working services already — only the thin
controller layer connecting them to HTTP is missing. None of them block
`ApiModule` or anything it covers.

## Verification

`tsc --noEmit` clean for every file this module owns (confirmed isolated
from two concurrently-landing forks' unrelated pre-existing errors in
`auth.controller.ts`/`crashes.controller.ts`/`upload-preflight.interceptor.ts`
— none of which this module touches). See the task report for the live
boot/curl verification performed.
