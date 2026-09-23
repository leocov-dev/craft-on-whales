# Players module notes

Non-obvious implementation decisions for `backend/src/players/`. See `AGENTS.md` and
`docs/architecture.md` for the module/DI conventions this follows.

## Delete Player (full wipe) — upstream parity 3.21

`PlayerRosterService.deletePlayer()` removes a player from usercache/whitelist/ops/banned-players,
their offline playerdata (`.dat`/`.dat_old`, modern `players/data/` and legacy `playerdata/`
layouts — resolved via `PlayerDataFileService.playerdataDir()` rather than re-deriving the
modern/legacy logic here), their inventory snapshot directory
(`logs/<serverId>/inventories/<uuid>/`), and their moderator notes (via `PlayerNotesService`).

**Refused while online**, reusing the exact same online-check the roster already uses everywhere
else (`listOnlineNames(serverId, { throwOnError: true })` against the RCON player list) — no
second online-detection mechanism. Rationale: a live player's role entries would just get
re-minted by the running JVM the moment it next writes those files, and a running world keeps a
live `.dat` in memory that would overwrite whatever we delete on its own next autosave.

When the server **is** running (but the target player is offline), role removal goes over RCON
first (`deop` / `whitelist remove` / `pardon`, best-effort) before the file edit, mirroring the
upstream hardening in commit `255b5d2`: the JVM can rewrite `whitelist.json`/`ops.json`/
`banned-players.json` from its in-memory state on its own schedule, so clearing RCON state first
stops it resurrecting what the file edit is about to delete.

This is intentionally **irreversible with no soft-delete/undo** — the API doc comment and the
frontend's `q-dialog` confirmation both say so explicitly. Scoped down from upstream's version:
this codebase has no stats/advancements file model (upstream's original Express/Handlebars app
tracked those under the world dir too), so deletion here covers the four things this codebase
actually models for a player (roster state, playerdata, inventory snapshots, notes) rather than
inventing deletion logic for data this rewrite never modeled in the first place.

## Temporary bans — no new scheduler abstraction, no new ban-tracking table

A ban's expiry rides the **vanilla ban-file format itself** — `banned-players.json` /
`banned-ips.json` already have an `expires` field the game reads on connect (see the existing
`PlayerFileEntry` interface, which already declared `expires`/`expiresOn` before this feature).
`banPlayer()`/`banIp()` now accept `durationMs` and, when set, always (re)write the file entry
with a real `expires` timestamp — RCON's own `/ban`/`/ban-ip` always writes `'forever'`, so a
durationMs ban re-writes the file after the RCON call even while the server is running, same
pattern the code already used for "server stopped → write the file ourselves."

**No new DB table for ban tracking.** The expiry lives entirely in the panel-managed JSON files
that already exist; there is no separate "tracked bans" row to keep in sync with them.

Expiry is resolved by a **lazy check on read** (`isBanExpired`, `banTimestampToMs`) — the same
pattern `SessionService` already uses for expired sessions (compare a stored timestamp against
`Date.now()` at read time, no timer, no new table). `listPlayers()`/`listBannedIps()` treat an
expired-but-still-present file entry as already pardoned, so the roster is never visibly wrong
after the actual expiry — the stale on-disk entry itself just sits there until something next
writes that file (a pardon, another ban, …), which is harmless: vanilla itself already ignores an
expired ban on connect regardless of whether the panel has cleaned up the file yet.

**A scheduled sweep (`ban-expiry-sweep` in `SchedulerService`'s `TASK_TYPES`) was attempted first**
— it's the more upstream-faithful design (commit `1d6701d` did exactly this) and would have been a
one-entry addition to the scheduler's existing data-driven task-type table, matching the pattern
used for `restart`/`backup`/`update-check`/`tmp-clean`/etc. It was dropped after it broke app boot:
wiring `PlayerRosterService` into `SchedulerService` requires `SchedulerModule` to import
`PlayersModule`, and `PlayersModule` already forwardRef-cycles through `InventoryModule` (see
`docs/architecture.md`'s "Circular module dependencies") — which itself has a **plain** (not
forwardRef'd) import of `ServersModule`, which forwardRefs `SchedulerModule`. Closing the loop at
the new `SchedulerModule → PlayersModule` edge produced a real `UndefinedModuleException` at boot
(`InventoryModule`'s `ServersModule` import evaluating to `undefined` mid-require-cycle), not just
a Nest DI-resolution nit. Untangling it cleanly would mean touching `InventoryModule`'s existing,
already-fragile forwardRef wiring too — real complexity creep in an unrelated module for a feature
the lazy check already fully covers on its own. Scoped down to lazy-check-only per this
repo's defense-in-depth rule (flagging instead of silently building the more complex option): if a
scheduled sweep is wanted later, it should go through the same
`import type` + lazily-`require()`'d `@Inject(forwardRef(...))` pattern `SchedulerService` already
uses for `ServerLifecycleService` (see `server-lifecycle.service.ts`), not a plain module import.

## IP-ban linkage — no new IP-capture plumbing

Banning an IP can be tagged with the player name it belongs to (`banIp(serverId, ip, reason,
{ player })`, written into `banned-ips.json`'s `player` field — same "extra field on the vanilla
ban entry" approach as `expires` above). This is what upstream's commit `1d6701d` actually means
by "IP ban player linkage" too — a **manual admin-supplied tag on the IP ban record**, not
automatic capture of a player's real IP.

This codebase already captures player join IPs, though, from
`LogClassifierService`'s `LOGGED_IN_RE` match on the console's `"<player>[/<ip>] logged in with
entity id"` line (port stripped), persisted by `LogIngestService` as a `player_events` row of type
`'join'` with `target` = the IP. `PlayerRosterService.getLastKnownIp(serverId, name)` reads the
most recent such row. The frontend's ban dialog fetches it when opening and, if present, offers an
"also ban this player's last-known IP" checkbox that fires a second `banIp()` call tagged with the
player's name — so the linkage feature is real (not just a free-text tag), built entirely on IP
capture this codebase already had for the analytics timeline. **No new IP-capture plumbing was
added** — evaluated against `AGENTS.md`'s defense-in-depth ask-first rule and this is reuse of an
existing capability, not new cross-cutting surface area.

## Moderator notes

Free-text notes, one row per note, in the new `player_notes` table (`db/schema/events.ts` /
`db/schema-pg/events.ts` — grouped there alongside `player_events`/`player_sessions`, the other
player-scoped analytics tables, rather than a standalone schema file for one table). Plain CRUD in
`PlayerNotesService`, split out of `PlayerRosterService` because notes have no RCON/file-edit
concern at all, unlike everything else in that service.

**Visibility**: gated behind the `players` capability on every notes route
(`@RequireServerPermission('players')`), the same capability that already gates ban/kick/op/
whitelist on this controller. A `viewer` role's default capability set is `['view']` only (see
`PermissionsService.ROLE_DEFAULTS`), so a viewer can see the roster but gets a 403 on notes —
consistent with every other player-mutating action already on this controller, not a new
visibility mechanism invented for notes specifically. The frontend additionally hides the Notes
menu entry behind `authStore.canWrite` (an existing getter, already used the same way in
`WorldsTab.vue`/`BlueprintsPage.vue`/etc.) so a viewer doesn't see an affordance that would just
403 — this is UI politeness on top of the real, backend-enforced gate, not the enforcement itself.

Deleting a player's whole record cascades to their notes (`PlayerNotesService.deletePlayerNotes`),
called from `deletePlayer()` above.
