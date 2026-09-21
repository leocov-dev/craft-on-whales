# Upstream parity ledger

This repo is a fork of [`anefzaoui/minecraft-server-manager`][upstream]. The last shared commit is
`457b0a6` ("docs: refresh README for 0.9.8", 2026-08-21). Since that point the fork was rewritten to
a NestJS backend + Vue 3/Quasar frontend, while upstream continued on its Express + Handlebars
stack through releases 0.10.0 – 0.14.0.

This file tracks what we have taken from upstream since the fork, what is still planned, and what we
deliberately turned down.

[upstream]: https://github.com/anefzaoui/minecraft-server-manager

## Ground rules

- **Upstream is reference and inspiration only.** Never merge, rebase onto, or cherry-pick from it —
  the two codebases have diverged past the point where any upstream patch applies. Every adopted
  item is written fresh against `backend/` and `frontend/`.
- No upstream remote is configured here. To review upstream code, clone it to a scratch directory
  and diff from the fork point:
  `git log --oneline --no-merges 457b0a6..HEAD`.
- **Every PR that lands an item flips its row to `Adopted` in the same PR**, and fills in the PR
  number.
- **A `Rejected` row must carry a reason.** That is the whole point of recording it — so the next
  sweep does not re-litigate a decision already made.
- When upstream ships something new, add a row here first, then open the PR.

## Status values

| Status        | Meaning                                     |
| ------------- | ------------------------------------------- |
| `Adopted`     | Implemented fresh in this repo and merged   |
| `In progress` | Branch open                                 |
| `Planned`     | Accepted into the backlog, not started      |
| `Rejected`    | Deliberately not doing it — reason required |
| `N/A`         | Does not apply to this fork's architecture  |

---

## Tier 1 — correctness and data safety

| Upstream ref                                   | Feature                                                                                                           | Status  | Our PR | Notes                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.13.2 `77c77aa` `5d87d21` `c890921`           | `server.properties` edits survive a restart (#39)                                                                 | Adopted | —      | `ServerPropertiesService` is the only writer now: it clears the env var backing each edited property and flags a recreate, and `preserveEdits()` restores our values after the game rewrites the file on a live whitelist toggle. Difficulty is written to the file as well as sent over RCON. See `backend/src/servers/SERVERS_NOTES.md`.      |
| 0.13.0 `f0cdcdd` `3ae0cf4`                     | Crash auto-restart when Docker reports `Action` instead of `status` (#23)                                         | Planned | —      | `docker-watcher.service.ts` reads `evt.status` only. Must keep clean-exit semantics intact.                                                                                                                                                                                                                                                     |
| 0.12.0 `21d68df` `02d0887` `4b72370` `ebfc4c9` | Unpinned modpack selector boot sweep (#21/#22)                                                                    | Planned | —      | The lost-worlds bug. Pin to the version actually installed, never a freshly resolved "latest".                                                                                                                                                                                                                                                  |
| 0.13.0 `49df789`                               | One deadline for a whole `docker exec`, including create and start                                                | Planned | —      | A stalled daemon must not hang a panel request forever.                                                                                                                                                                                                                                                                                         |
| 0.10.0 `6d8ee37` `40cdc63`                     | Startup watchdog and `stalled` status                                                                             | Planned | —      |                                                                                                                                                                                                                                                                                                                                                 |
| 0.13.1 `4fe33fc` `86a0d4f`                     | Heap size fields reach Java in megabytes (#25)                                                                    | Adopted | —      | `JvmMemoryService` normalises `MEMORY`/`INIT_MEMORY`/`MAX_MEMORY` to megabytes at the container-env boundary — the panel's own heap field was already safe, the free-form `env_json` path was not. The meters and heap fields now say that Java fills a heap given up front, so an idle server reading its full heap stops looking like a leak. |
| 0.13.0 `5ab104e` `39076f5`                     | Malformed zip and invalid cron are 4xx with a sentence                                                            | Planned | —      |                                                                                                                                                                                                                                                                                                                                                 |
| 0.10.0 `6719b06`                               | Backup retention buckets per reason, plus a `pre-restore` bucket                                                  | Planned | —      | Today: a single `KEEP_SCHEDULED = 10`. A safety snapshot must never evict a manual backup.                                                                                                                                                                                                                                                      |
| 0.13.0 `b707bd4` `574fd93` `7f12975`           | Docker events buffer cap and reconnect backoff; single-flight Mojang lookups; dir sizing does not follow symlinks | Planned | —      |                                                                                                                                                                                                                                                                                                                                                 |

## Tier 2 — security hardening

| Upstream ref                              | Feature                                                                                                                                      | Status  | Our PR | Notes                                                                                                                                                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.10.0 `src/services/secretsMigration.js` | Dedicated at-rest encryption key, independent of `SESSION_SECRET`                                                                            | Planned | —      | **We diverge:** the key comes from the environment (`SECRET_KEY`) only. Never generated, never written to `data/`. Malformed key is a hard boot error; absent falls back to the `SESSION_SECRET`-derived key with a deprecation warning. |
| 0.13.0 `08a2cff` `b3ed4bb` `3693ecc`      | Auth hardening: setup-PIN gate and lockout, refuse spoofable `TRUST_PROXY=true`, re-auth to change a password, revoke sessions on 2FA enable | Planned | —      | Builds on the existing `auth/login-rate-limit.service.ts`.                                                                                                                                                                               |
| 0.10.0 `3693ecc` `9fd8e1c`                | `SameSite=lax` session cookie with `Origin`/`Referer` checks on writes                                                                       | Planned | —      |                                                                                                                                                                                                                                          |
| 0.10.0 `src/utils/zip.js`                 | One consolidated safe zip extractor                                                                                                          | Planned | —      | Zip-slip containment, backslash-separator entries rejected, size caps — shared by every import, restore and world-upload path.                                                                                                           |
| 0.11.0 `edd21bc`                          | Verify downloads against registry-published checksums                                                                                        | Planned | —      | Integrity only. **Must not reintroduce the SSRF guard removed in `3719117`.**                                                                                                                                                            |
| 0.10.0                                    | Side-effecting GETs gated to admin/operator                                                                                                  | Planned | —      | Event export, world download, `.mrpack`.                                                                                                                                                                                                 |

## Tier 3 — high-value features

| Upstream ref                                   | Feature                                                                    | Status  | Our PR | Notes                                                                                                                                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------- | ------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.14.0 `a8d8262` `a1496d5` `cba1430` `0dc57cf` | Per-server permissions (#43)                                               | Planned | —      | The `user_server_permissions` table already exists here and is unreferenced — no schema change needed. Needs a structural test that fails the build when a server-scoped write route ships without the guard. |
| 0.13.0 `3bd2f86` `90a6981` `07c6cd2`           | Public read-only API behind admin-minted Bearer tokens                     | Planned | —      | New `api_tokens` table in **both** schema dialects.                                                                                                                                                           |
| 0.13.0 `455f1a0` `707902b` `c0c67c2`           | Ignore an update, per mod / pack / image / MC version / loader build       | Planned | —      |                                                                                                                                                                                                               |
| 0.13.0 `fcb6266`                               | Admin-configurable defaults for new servers                                | Planned | —      | Layers on top of `config/resource-defaults.resolver.ts`.                                                                                                                                                      |
| 0.13.0 `c12c445`                               | Backup rename, plus max-age and max-size retention ceilings                | Planned | —      | Newest backup is never pruned.                                                                                                                                                                                |
| 0.13.0 `365f368` `255b5d2` `1d6701d`           | Delete Player (full wipe), temporary bans, moderator notes, IP-ban linkage | Planned | —      | Refused while the player is online.                                                                                                                                                                           |
| 0.13.0 `eb0eb8c`                               | Roster status: Online / Whitelisted / Joined / Banned (#29)                | Planned | —      |                                                                                                                                                                                                               |
| 0.13.0 `f714b06`                               | Check for panel updates on Settings                                        | Planned | —      | Newest stable GitHub release only, never pre-releases, never touches files.                                                                                                                                   |
| 0.13.0 `484f746` `e08caf4` `c64b720`           | Full vanilla boolean gamerule coverage, read concurrently                  | Planned | —      | We ship 10 gamerules today. A gamerule this MC version lacks is _unsupported_, not a failed read.                                                                                                             |
| 0.10.0                                         | Discord "Alerts" category                                                  | Planned | —      | OOM, unhealthy, stalled boot, stop-failed, failed schedule, quota stop, offline-after-restart, crash loop, crash report, update-failed.                                                                       |
| 0.10.0 `a13d48f`                               | `GET /api/status/summary` and a real `mc-health` container healthcheck     | Planned | —      | `/healthz` already exists here.                                                                                                                                                                               |
| 0.10.0 `src/web/middleware/rateLimit.js`       | App-level rate limiting on `/api`                                          | Planned | —      | The reverse proxy owns network-level limiting (see `AGENTS.md`). Confirm before building if this grows past a thin guard.                                                                                     |

## Tier 4 — larger features

| Upstream ref                                           | Feature                                                                        | Status  | Our PR | Notes                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ | ------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| 0.11.0 `e85b951` `475aa85`                             | Hangar, SpigotMC (Spiget) and GitHub Releases as content sources               | Planned | —      | Keyless. GitHub responses ETag-cached, optional `GITHUB_TOKEN`.                                              |
| 0.11.0 `475aa85`                                       | Universal add-by-link across every source                                      | Planned | —      |                                                                                                              |
| 0.10.0 `407c328` `a72ff2f` `e2d00be`; 0.11.0 `c51123b` | Zip and `.mrpack` import on the Mods tab, with reversible `overrides/`         | Planned | —      | Jar identification: Modrinth sha1 → CurseForge fingerprint (murmur2) → jar metadata.                         |
| 0.10.0 `8a7c330`                                       | Create a server from an uploaded zip                                           | Planned | —      |                                                                                                              |
| 0.10.0                                                 | Blocked-download fallback (Open CurseForge + Upload jar)                       | Planned | —      |                                                                                                              |
| 0.13.0 `4a6ac9c` `6e62d3a` `d253103`                   | Monitoring → Live: TPS/MSPT, Health & Stability, combined resource overview    | Planned | —      |                                                                                                              |
| 0.13.0 `4a6ac9c` `50b96cf` `e8249c2`                   | Shrink World                                                                   | Planned | —      | Every dimension, real spawn from `level.dat`, dry-run works on a running server.                             |
| 0.11.0 `e10c281`                                       | mclo.gs crash sharing and automated crash analysis                             | Planned | —      |                                                                                                              |
| 0.10.0 `c3417b2` `bad862b` `4d253e7`                   | Datapacks on the Mods tab, orphan adoption, icon and metadata repair           | Planned | —      |                                                                                                              |
| 0.10.0 `2fe2aba`                                       | Compatibility solver accepts CurseForge projects                               | Planned | —      |                                                                                                              |
| 0.10.0 `77e9248`; 0.11.0 `9428915`                     | Modrinth MC-version compatibility override; Quilt accepts fabric-tagged builds | Planned | —      | Still prefer the server's own loader.                                                                        |
| 0.10.0 `src/db/vacuum-worker.js`; 0.13.0 `b707bd4`     | Panel-DB snapshot, boot integrity check, bounded pruning                       | Planned | —      | SQLite uses `VACUUM INTO`; the Postgres path needs its own approach, to be documented in `DRIZZLE_NOTES.md`. |
| 0.10.0 `8629e65`                                       | PWA / Add to Home Screen                                                       | Planned | —      |                                                                                                              |
| 0.14.0 `e0e476b`                                       | Operator task guides                                                           | Planned | —      | Backups, choosing a loader, moving a server, server memory, server won't start.                              |

## Rejected

| Upstream ref                                          | Feature                                             | Reason                                                                                                                                                                   |
| ----------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0.10.0 `63c8e9c` `789022a`, `src/services/wizard*.js` | Per-server OpenAI/Ollama chatbot and in-game powers | Large surface with its own authorization, audit and prompt-injection model, for a feature outside this panel's purpose. Not worth the maintenance or the attack surface. |
| 0.10.0 `3ff466c` `4849b8f` `2039139`                  | Profile pictures, presets and the avatar cropper    | Cosmetic, and it drags in image sniffing, SVG scrubbing and decompression-bomb guards for no operational benefit.                                                        |
| `cc95b70`                                             | One-shot Linux installer script                     | We ship Docker Compose. A second install path is another thing to keep working.                                                                                          |
| 0.10.0 `789022a`                                      | Shared SSRF guard on server-side downloads          | Removed here on purpose in `3719117` — it blocked legitimate LAN and self-hosted sources. Do not reintroduce it, including as part of the checksum work.                 |

## N/A — does not apply to this fork

| Upstream ref                            | Feature                               | Why not                                                       |
| --------------------------------------- | ------------------------------------- | ------------------------------------------------------------- |
| 0.11.0 `02eed44`                        | PaperMC Fill v3 API migration         | We never call the Paper API; the itzg image resolves builds.  |
| 0.10.0                                  | esbuild client bundle                 | The frontend is Vite/Quasar.                                  |
| `cd80751`                               | npm → pnpm migration                  | Not adopting a second package manager convention mid-rewrite. |
| 0.13.1 `06c00d8` `e269121`              | Handlebars JSON-island escaping fixes | No Handlebars here.                                           |
| 0.13.0 `04295b6` … `0a6e20f`            | Mobile-first table and layout passes  | Quasar components already handle this.                        |
| `ac45a2c` `65751a0` `fed2dfc` `32f2759` | Copy and Title-Case passes            | Upstream's house style, not ours.                             |
