# Packs module notes

## The pinning invariant, and why a boot sweep exists at all

`PacksService.applyPack()` has always built pinned env by construction —
every install/version-change that goes through the pack browser UI writes a
concrete `CF_FILE_ID`/`MODRINTH_VERSION`/`FTB_MODPACK_VERSION_ID`/
`GTNH_PACK_VERSION` alongside the platform selector, never a bare slug. That
alone is not the whole guarantee: the itzg image re-resolves an **unpinned**
selector to whatever is currently "latest" on **every container start**, and
two write paths bypass `applyPack()` entirely:

1. `POST /api/servers` and `PATCH /api/servers/:id` (`ServersController`) take
   a raw `env: Record<string, string>` straight from the request body —
   nothing stopped a caller (or a hand-written API script) from setting
   `CF_SLUG` with no `CF_FILE_ID`.
2. Blueprint import (`BlueprintImportService`) replays a blueprint's exported
   env through `ServerLifecycleService.createServer()` — the same call
   `ServersController.create()` uses — so a blueprint captured from a
   pre-existing unpinned server (or hand-edited manifest) would reproduce the
   same unpinned selector on import.

This is the upstream lost-worlds bug (`anefzaoui/minecraft-server-manager`
#21/#22, fixed there in 0.12.0): a server silently "updates" itself to a
different modpack build on its next restart, which can point at incompatible
mods for the world already on disk, orphaning it. Two pieces close this:

- **`PackPinGuardService`** (`backend/src/servers/pack-pin-guard.service.ts`)
  — a pure, dependency-free detector + `assertPinned()` guard, called from
  `ServerLifecycleService.createServerImpl()` and `.updateServer()` (the two
  places `servers.env_json` is actually written from arbitrary input). It
  lives in `servers/`, not `packs/`, specifically to avoid a new
  `PacksModule → ServersModule` import: `PacksModule` already depends on
  `ServersModule` (`ServerQueryService`, `JavaMatrixService`) via a
  `forwardRef()`, and `ServerLifecycleService` needs the guard directly, so
  putting it in the module that already flows one-directionally into
  `ServerLifecycleService`'s own module avoids adding a second cycle.
- **`PackPinSweepService`** (this directory) — a boot-time, idempotent
  repair pass for servers that already carry the unpinned shape (created
  before the guard above existed, or written directly against the DB/API
  outside the panel entirely). Runs from `OnModuleInit`, which fires during
  `app.init()` in `main.ts` — always after `runMigrations()` has already run
  (see `main.ts`'s ordering comment), so `pack_pin_needs_review` and every
  other column it touches are guaranteed to exist.

## Why the sweep never re-resolves "latest"

That re-resolution IS the bug. The sweep's only source of truth is the
panel's own `server_packs` row for that server — the same table
`applyPack()` writes on every real install. It is **never** allowed to call
`resolvePack()`/hit an external registry to "figure out" what's installed;
doing so would just move the coin-flip from "next container start" to
"next panel boot," with the exact same blast radius.

**Why not read an install manifest on disk instead (or as well)?** Upstream's
own fix trusted `.curseforge-manifest.json` (written by `mc-image-helper` for
CurseForge installs) as a fallback when no DB record existed, because
upstream's server-tracking table didn't exist before a certain version. This
fork's `server_packs` table has existed since `PacksService` was written and
is _always_ populated by the only code path that ever installs a pack — so
by construction, any server that was ever installed through this panel
already has the DB record. The manifest route was deliberately left out
here:

- `ModManifestService` (`backend/src/mods/mod-manifest.service.ts`) already
  parses `.curseforge-manifest.json` in this codebase, but only walks it for
  **per-jar** `{slug, projectId}` entries (individual mods) — it does not
  expose the modpack's own top-level file id or version, which is what a
  pin actually needs.
- The manifest's real top-level shape (the exact field carrying the
  modpack's own installed fileId, distinct from the per-file CurseForge
  project/file ids inside it) is not something this codebase has verified
  against a live `mc-image-helper` install. Parsing a guessed field to
  produce a pin is worse than not pinning at all — a wrong guess writes a
  _plausible-looking but incorrect_ `CF_FILE_ID`, which is exactly the
  silent-corruption failure mode this whole feature exists to prevent.

So: DB record only, and if it's missing there is genuinely no trustworthy
evidence available to this panel — the server is flagged, not guessed at.

## Cross-checking by project ref (slug), not just platform

Trusting a `server_packs` row by platform alone is not enough. A server
hand-edited to point `CF_SLUG` at a _different_ pack, with the old
`server_packs` row from the previous pack left untouched (since that row is
never touched by a raw env write, only by `applyPack()`), would otherwise
let the sweep confidently pin the wrong pack's file id onto the new slug.
`PackPinGuardService.unpinnedSelectors()` extracts the selector's own
project reference (`CF_SLUG`, or the slug embedded in `CF_PAGE_URL`;
`MODRINTH_MODPACK`; `FTB_MODPACK_ID`; the constant `'gtnh'` for GTNH, which
has no separate reference) alongside each issue it reports, lowercased.
`PackPinSweepService.sweep()` only trusts a `server_packs` row when its
`platform` **and** (when the issue carries one) `projectRef` match — a
mismatch is treated exactly like "no record at all."

## What "flagged" means, and how it clears

`servers.pack_pin_needs_review` (both dialects) is set `true` only when the
sweep found an unpinned selector with no trustworthy record. It is
deliberately **not** a boot blocker — the server stays exactly as it was
(still possibly re-resolving "latest" on its own next start, same as before
this feature), and Settings is expected to surface a warning with a manual
version picker (the existing pack-browser `resolvePack`/`applyPack` flow
already lets an admin choose a specific version — no new install path was
needed for this).

The flag clears the moment a pin is genuinely established, from any of three
places: `PackPinSweepService` itself (when it does find trustworthy
evidence), `PacksService.applyPack()` (an admin picks a version manually or
upgrades), or `ServerLifecycleService.updateServer()` (a raw env write that
now passes `PackPinGuardService` — since a passing write can only leave a
pinned selector or none at all, any stale flag is cleared unconditionally
alongside it).

## The "create from pack" flow's legitimate transient unpinned state

`PacksController`'s `POST /api/servers/from-pack` endpoint intentionally
creates the server row first (via `ServerLifecycleService.createServer()`,
with `type` already set to e.g. `AUTO_CURSEFORGE`/`GTNH` but no pack-selector
env yet), then calls `PacksService.applyPack({ force: true })` to write the
real pinned env, and only _then_ starts the container. The container is
therefore never created against an unpinned state — but the intermediate DB
row legitimately has none. `CreateServerOptions.deferPackPin` exists so this
one call site can opt out of `PackPinGuardService` at creation time; every
other caller (the plain `POST /api/servers`, and blueprint import via the
same `createServer()`) leaves it unset and gets the guard.
