'use strict';

// Inventory forensics + god-mode editing. Offline NBT inspection of playerdata
// (.dat) files, item search across players and servers, point-in-time JSON
// snapshots with diffing, RCON give/clear, and per-slot editing (set / delete /
// count / move) that auto-picks its mechanism: `item replace entity` over RCON
// while the player is online, direct .dat rewrites (gzip'd NBT, with rotating
// backups) while they are not.
//
// SNAPSHOT STORAGE DECISION: snapshots are stored as small JSON files under
// data/logs/<serverId>/inventories/<uuid>/<ts>-<reason>.json instead of DB
// rows. They are point-in-time blobs that are never queried relationally
// (listing = a directory read, ordering = the filename timestamp), they prune
// like every other log artifact, and every path resolves through the path
// guard so nothing escapes ./data.

import type { NormalizedItem } from './inventory/types';

const httpError = require('../utils/httpError') as typeof import('../utils/httpError');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const nbt = require('prismarine-nbt') as typeof import('prismarine-nbt');
const db = require('../db') as typeof import('../db');
const { dataPath } = require('../storage/pathGuard') as typeof import('../storage/pathGuard');
const { recordEvent } = require('../events') as typeof import('../events');
const containers = require('../docker/containers') as typeof import('../docker/containers');
const { execCapture, inspectStatus } = containers;
const {
  assertUuid,
  assertName,
  assertItemId,
  textComponentToString,
  normalizeItem,
  normalizeItemDeep,
  detectNestedInventories,
  UUID_RE,
  NAME_RE,
  NESTED_MAX_PATH,
  NESTED_KEY_RE,
} = require('./inventory/nbt') as typeof import('./inventory/nbt');

type InspectStatusResult = Awaited<ReturnType<typeof inspectStatus>>;

const SNAPSHOT_FILE_RE =
  /^logs\/([A-Za-z0-9_-]{1,40})\/inventories\/([0-9a-f-]{36})\/(\d{10,16})-([a-z0-9_-]{1,32})\.json$/;
const RUNNING_STATES = new Set(['running', 'unhealthy']); // rcon answers while unhealthy

// Vanilla armor slot numbers inside the playerdata Inventory list.
const ARMOR_SLOTS: Record<number, string> = { 100: 'feet', 101: 'legs', 102: 'chest', 103: 'head' };
const OFFHAND_SLOT = -106;

// ---------------------------------------------------------------------------
// Playerdata read — resolve the active world's playerdata directory, parse the
// .dat NBT, and shape it into the panel's inventory view.

/** Minimal server-row shape used here. The full row type lives in
 *  src/services/servers.js (not yet converted). */
interface ServerLike {
  id: string;
  env?: Record<string, string>;
}

function playerdataDir(serverId: string): string {
  const server: ServerLike | null | undefined = require('./servers').getServer(serverId);
  if (!server) throw httpError(404, 'Server not found');
  const level: string = require('./worlds').activeLevelName(server);
  const modern = dataPath('servers', serverId, level, 'players', 'data');
  const legacy = dataPath('servers', serverId, level, 'playerdata');
  const has = (dir: string): boolean => {
    try {
      return fs.readdirSync(dir).some((f: string) => f.endsWith('.dat'));
    } catch {
      return false;
    }
  };
  if (has(modern)) return modern;
  if (has(legacy)) return legacy;
  return fs.existsSync(modern) ? modern : legacy;
}

/** usercache.json → Map(lowercased uuid → name) plus Map(lowercased name → uuid). */
function usercacheMaps(serverId: string): { byUuid: Map<string, string>; byName: Map<string, string> } {
  const byUuid = new Map<string, string>();
  const byName = new Map<string, string>();
  try {
    const raw = fs.readFileSync(dataPath('servers', serverId, 'usercache.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const e of parsed) {
        if (!e || !e.uuid || !e.name) continue;
        byUuid.set(String(e.uuid).toLowerCase(), e.name);
        byName.set(String(e.name).toLowerCase(), String(e.uuid).toLowerCase());
      }
    }
  } catch {
    /* no usercache yet */
  }
  return { byUuid, byName };
}

/** 'minecraft:overworld' | numeric legacy ids (-1 nether, 1 end) | unknown as-is. */
function normalizeDimension(dim: unknown): string | null {
  if (typeof dim === 'string') return dim;
  if (typeof dim === 'number' || typeof dim === 'bigint') {
    const n = Number(dim);
    if (n === -1) return 'minecraft:the_nether';
    if (n === 1) return 'minecraft:the_end';
    return 'minecraft:overworld';
  }
  return null;
}

interface PlayerPosition {
  x: number;
  y: number;
  z: number;
  dimension: string | null;
}

interface PlayerInventoryData {
  uuid: string;
  name: string | null;
  inventory: NormalizedItem[];
  enderChest: NormalizedItem[];
  armor: (NormalizedItem & { piece: string })[];
  offhand: NormalizedItem | null;
  pos: PlayerPosition | null;
  health: number | null;
  xpLevel: number | null;
  lastModified: number;
}

/** Parse <world>/playerdata/<uuid>.dat. */
async function readPlayerData(serverId: string, uuidInput: string): Promise<PlayerInventoryData> {
  const uuid = assertUuid(uuidInput);
  const file = path.join(playerdataDir(serverId), `${uuid}.dat`);
  let stat: import('node:fs').Stats;
  try {
    stat = await fsp.stat(file);
  } catch {
    throw httpError(404, 'No saved data for this player yet — they need to have joined the server at least once');
  }

  let data: any;
  try {
    const buf = await fsp.readFile(file);
    const { parsed } = await nbt.parse(buf); // handles gzip + endianness detection
    data = nbt.simplify(parsed);
  } catch (err) {
    throw httpError(422, `Could not parse the player data file: ${(err as Error).message}`);
  }

  const inventory: NormalizedItem[] = [];
  const armor: (NormalizedItem & { piece: string })[] = [];
  let offhand: NormalizedItem | null = null;
  for (const raw of Array.isArray(data.Inventory) ? data.Inventory : []) {
    const item = normalizeItemDeep(raw);
    if (!item) continue;
    if (item.slot !== null && ARMOR_SLOTS[item.slot]) {
      armor.push({ ...item, piece: ARMOR_SLOTS[item.slot]! });
    } else if (item.slot === OFFHAND_SLOT) {
      offhand = item;
    } else {
      inventory.push(item);
    }
  }
  // MC 1.21.5+ (26.x) keeps worn gear in an `equipment` compound instead of
  // Inventory slots 100-103 / -106 — merge both layouts.
  const eq = data.equipment && typeof data.equipment === 'object' ? data.equipment : {};
  for (const piece of ['head', 'chest', 'legs', 'feet']) {
    if (eq[piece] && eq[piece].id !== undefined && !armor.some((a) => a.piece === piece)) {
      const item = normalizeItemDeep(eq[piece]);
      if (item) armor.push({ ...item, piece });
    }
  }
  if (!offhand && eq.offhand && eq.offhand.id !== undefined) {
    offhand = normalizeItemDeep(eq.offhand);
  }
  const enderChest: NormalizedItem[] = (Array.isArray(data.EnderItems) ? data.EnderItems : [])
    .map(normalizeItemDeep)
    .filter((x: NormalizedItem | null): x is NormalizedItem => Boolean(x));

  let pos: PlayerPosition | null = null;
  if (Array.isArray(data.Pos) && data.Pos.length === 3) {
    pos = {
      x: Math.round(Number(data.Pos[0]) * 10) / 10,
      y: Math.round(Number(data.Pos[1]) * 10) / 10,
      z: Math.round(Number(data.Pos[2]) * 10) / 10,
      dimension: normalizeDimension(data.Dimension),
    };
  }

  const { byUuid } = usercacheMaps(serverId);
  return {
    uuid,
    name: byUuid.get(uuid) || null,
    inventory,
    enderChest,
    armor,
    offhand,
    pos,
    health: typeof data.Health === 'number' ? Math.round(data.Health * 10) / 10 : null,
    xpLevel: typeof data.XpLevel === 'number' ? data.XpLevel : null,
    lastModified: stat.mtimeMs,
  };
}

interface PlayerWithData {
  uuid: string;
  name: string | null;
  lastModified: number;
}

/** Every player with a playerdata file: [{uuid, name, lastModified}], newest first. */
async function listPlayersWithData(serverId: string): Promise<PlayerWithData[]> {
  const dir = playerdataDir(serverId);
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // world not generated yet — nobody has joined
  }
  const { byUuid } = usercacheMaps(serverId);
  const players: PlayerWithData[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.dat')) continue; // skips .dat_old backups
    const uuid = e.name.slice(0, -4).toLowerCase();
    if (!UUID_RE.test(uuid)) continue;
    let stat: import('node:fs').Stats;
    try {
      stat = await fsp.stat(path.join(dir, e.name));
    } catch {
      continue;
    }
    players.push({ uuid, name: byUuid.get(uuid) || null, lastModified: stat.mtimeMs });
  }
  players.sort((a, b) => b.lastModified - a.lastModified);
  return players;
}

// ---------------------------------------------------------------------------
// Item search

/** All sections of a parsed playerdata as [where, item] pairs. */
function* iterateItems(data: PlayerInventoryData): Generator<[string, NormalizedItem]> {
  for (const item of data.inventory) yield ['inventory', item];
  for (const item of data.armor) yield ['armor', item];
  if (data.offhand) yield ['offhand', data.offhand];
  for (const item of data.enderChest) yield ['enderChest', item];
}

interface ItemSearchHit {
  player: { uuid: string; name: string | null };
  where: string;
  slot: number | null;
  id: string;
  count: number;
  displayName: string | null;
}

/**
 * Scan every playerdata file for items whose id or display name contains
 * `query` (case-insensitive). Unreadable files are skipped, never fatal.
 */
async function searchItems(
  serverId: string,
  query: string | null | undefined,
  { limit = 500 }: { limit?: number } = {}
): Promise<ItemSearchHit[]> {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  if (!q) return [];
  const results: ItemSearchHit[] = [];
  for (const player of await listPlayersWithData(serverId)) {
    let data: PlayerInventoryData;
    try {
      data = await readPlayerData(serverId, player.uuid);
    } catch {
      continue; // corrupt or in-flight write — skip this player
    }
    for (const [where, item] of iterateItems(data)) {
      const matches =
        item.id.toLowerCase().includes(q) || (item.displayName && item.displayName.toLowerCase().includes(q));
      if (!matches) continue;
      results.push({
        player: { uuid: player.uuid, name: player.name },
        where,
        slot: item.slot,
        id: item.id,
        count: item.count,
        displayName: item.displayName || null,
      });
      if (results.length >= limit) return results;
    }
  }
  return results;
}

/** searchItems across every server: [{serverId, serverName, ...hit}]. */
async function searchAllServers(
  query: string | null | undefined,
  { limit = 500 }: { limit?: number } = {}
): Promise<(ItemSearchHit & { serverId: string; serverName: string })[]> {
  const results: (ItemSearchHit & { serverId: string; serverName: string })[] = [];
  for (const server of require('./servers').listServers()) {
    if (results.length >= limit) break;
    let hits: ItemSearchHit[] = [];
    try {
      hits = await searchItems(server.id, query, { limit: limit - results.length });
    } catch {
      continue; // one bad server must not sink the global search
    }
    for (const hit of hits) {
      results.push({ serverId: server.id, serverName: server.display_name, ...hit });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Snapshots (JSON files under data/logs/<serverId>/inventories/<uuid>/)

function snapshotDir(serverId: string, uuid: string): string {
  return dataPath('logs', serverId, 'inventories', assertUuid(uuid));
}

function cleanReason(reason: string | null | undefined): string {
  const r = String(reason || 'manual')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, 32);
  return r || 'manual';
}

interface SnapshotMeta {
  file: string;
  ts: number;
  reason: string;
}

interface SnapshotMetaWithSize extends SnapshotMeta {
  size: number;
}

/** Write the current readPlayerData result to a timestamped snapshot file. */
async function snapshot(serverId: string, uuid: string, reason: string = 'manual'): Promise<SnapshotMeta> {
  const data = await readPlayerData(serverId, uuid);
  const dir = snapshotDir(serverId, uuid);
  await fsp.mkdir(dir, { recursive: true });
  let ts = Date.now();
  while (fs.existsSync(path.join(dir, `${ts}-${cleanReason(reason)}.json`))) ts += 1; // same-ms collision
  const name = `${ts}-${cleanReason(reason)}.json`;
  await fsp.writeFile(
    path.join(dir, name),
    JSON.stringify({ ts, reason: cleanReason(reason), serverId, data }, null, 2)
  );
  return {
    file: path.posix.join('logs', serverId, 'inventories', data.uuid, name),
    ts,
    reason: cleanReason(reason),
  };
}

/** Snapshots for one player, newest first (metadata parsed from filenames). */
async function listSnapshots(serverId: string, uuidInput: string): Promise<SnapshotMetaWithSize[]> {
  const uuid = assertUuid(uuidInput);
  const dir = snapshotDir(serverId, uuid);
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const snapshots: SnapshotMetaWithSize[] = [];
  for (const e of entries) {
    const m = /^(\d{10,16})-([a-z0-9_-]{1,32})\.json$/.exec(e.isFile() ? e.name : '');
    if (!m) continue;
    let size = 0;
    try {
      size = (await fsp.stat(path.join(dir, e.name))).size;
    } catch {
      /* racing prune */
    }
    snapshots.push({
      file: path.posix.join('logs', serverId, 'inventories', uuid, e.name),
      ts: Number(m[1]),
      reason: m[2]!,
      size,
    });
  }
  snapshots.sort((a, b) => b.ts - a.ts);
  return snapshots;
}

interface LoadedSnapshot extends SnapshotMeta {
  uuid: string;
  data: PlayerInventoryData;
}

/** Load one snapshot by its rel path (strict shape check + path guard). */
function getSnapshot(relFile: string): LoadedSnapshot {
  const m = SNAPSHOT_FILE_RE.exec(String(relFile || ''));
  if (!m) throw httpError(400, 'Invalid snapshot file reference');
  let raw: string;
  try {
    raw = fs.readFileSync(dataPath(relFile), 'utf8'); // dataPath re-guards containment
  } catch {
    throw httpError(404, 'Snapshot not found — it may have been pruned');
  }
  try {
    const parsed = JSON.parse(raw);
    return { file: relFile, ts: Number(m[3]), reason: m[4]!, uuid: m[2]!, data: parsed.data || parsed };
  } catch {
    throw httpError(422, 'Snapshot file is corrupt');
  }
}

interface TallyEntry {
  id: string;
  displayName: string | null;
  count: number;
}

/** Aggregate item counts across all sections, keyed by id + display name. */
function tallyItems(data: PlayerInventoryData): Map<string, TallyEntry> {
  const tally = new Map<string, TallyEntry>();
  for (const [, item] of iterateItems(data)) {
    const key = `${item.id} ${item.displayName || ''}`;
    const cur = tally.get(key);
    if (cur) cur.count += item.count;
    else tally.set(key, { id: item.id, displayName: item.displayName || null, count: item.count });
  }
  return tally;
}

interface SnapshotDiff {
  a: SnapshotMeta;
  b: SnapshotMeta;
  added: TallyEntry[];
  removed: TallyEntry[];
  changed: { id: string; displayName: string | null; from: number; to: number }[];
}

/**
 * Diff two snapshots (rel paths). Items are keyed by id + displayName so a
 * renamed item counts as its own line.
 */
function diffSnapshots(aFile: string, bFile: string): SnapshotDiff {
  const a = getSnapshot(aFile);
  const b = getSnapshot(bFile);
  const before = tallyItems(a.data);
  const after = tallyItems(b.data);

  const added: TallyEntry[] = [];
  const removed: TallyEntry[] = [];
  const changed: SnapshotDiff['changed'] = [];
  for (const [key, item] of after) {
    const prev = before.get(key);
    if (!prev) added.push(item);
    else if (prev.count !== item.count) {
      changed.push({ id: item.id, displayName: item.displayName, from: prev.count, to: item.count });
    }
  }
  for (const [key, item] of before) {
    if (!after.has(key)) removed.push(item);
  }
  const meta = (s: LoadedSnapshot): SnapshotMeta => ({ file: s.file, ts: s.ts, reason: s.reason });
  return { a: meta(a), b: meta(b), added, removed, changed };
}

/** Keep only the newest `keepPerPlayer` snapshots for every player of a server. */
async function pruneSnapshots(serverId: string, keepPerPlayer: number = 50): Promise<{ pruned: number }> {
  const base = dataPath('logs', serverId, 'inventories');
  let uuids: string[] = [];
  try {
    uuids = (await fsp.readdir(base, { withFileTypes: true }))
      .filter((e: import('node:fs').Dirent) => e.isDirectory() && UUID_RE.test(e.name))
      .map((e: import('node:fs').Dirent) => e.name);
  } catch {
    return { pruned: 0 };
  }
  let pruned = 0;
  for (const uuid of uuids) {
    const snapshots = await listSnapshots(serverId, uuid);
    for (const snap of snapshots.slice(keepPerPlayer)) {
      try {
        await fsp.rm(dataPath(snap.file), { force: true });
        pruned += 1;
      } catch {
        /* already gone */
      }
    }
  }
  return { pruned };
}

// ---------------------------------------------------------------------------
// Automatic snapshots on join/death (rides on the player_events parser)

let watcherTimer: NodeJS.Timeout | null = null;
let lastEventId = 0;

/**
 * Poll player_events every `intervalMs` for new join/death rows and snapshot
 * that player's inventory. Starts from MAX(id) so old history is never
 * replayed. All errors are contained — the watcher can never crash the panel.
 */
function startSnapshotWatcher({ intervalMs = 20000 }: { intervalMs?: number } = {}): void {
  if (watcherTimer) return;
  try {
    const row = db.get('SELECT MAX(id) AS maxId FROM player_events');
    lastEventId = Number(row && row.maxId) || 0;
  } catch (err) {
    console.error('[inventory] snapshot watcher init failed:', (err as Error).message);
    lastEventId = 0;
  }
  watcherTimer = setInterval(() => {
    pollPlayerEvents().catch((err: Error) => console.error('[inventory] snapshot watcher:', err.message));
  }, intervalMs);
  watcherTimer.unref();
}

async function pollPlayerEvents(): Promise<void> {
  const rows = db.all(
    "SELECT id, server_id, type, player FROM player_events WHERE id > ? AND type IN ('join', 'death') ORDER BY id LIMIT 200",
    lastEventId
  );
  for (const row of rows) {
    lastEventId = Math.max(lastEventId, Number(row.id));
    const player = row.player == null ? null : String(row.player);
    if (!player || !NAME_RE.test(player)) continue;
    try {
      const serverId = String(row.server_id);
      const { byName } = usercacheMaps(serverId);
      const uuid = byName.get(player.toLowerCase());
      if (!uuid) continue; // never joined far enough to be cached
      if (!fs.existsSync(path.join(playerdataDir(serverId), `${uuid}.dat`))) continue; // no .dat yet
      await snapshot(serverId, uuid, String(row.type));
      await pruneSnapshots(serverId);
    } catch {
      // One failed snapshot (corrupt file, deleted server, …) must not stop the sweep.
    }
  }
}

// ---------------------------------------------------------------------------
// RCON give/clear (running servers only)

async function assertRunning(serverId: string, what: string): Promise<void> {
  let info: InspectStatusResult;
  try {
    info = await inspectStatus(serverId);
  } catch {
    throw httpError(503, `Docker is not reachable — cannot ${what}`);
  }
  if (!info.exists || !RUNNING_STATES.has(info.status)) {
    throw httpError(
      409,
      `The server must be running to ${what} — item edits on stopped servers are out of scope (offline data is read-only)`
    );
  }
}

async function rcon(serverId: string, ...args: unknown[]): Promise<string> {
  // '--' terminates flag parsing so args like '-106' can never become flags.
  const out = await execCapture(serverId, ['rcon-cli', '--', ...args.map(String)]);
  return (require('../utils/ansi') as typeof import('../utils/ansi')).cleanText(String(out || '')).trim();
}

/** Surface the server's own error text on command failures. */
function assertRconOk(out: string, playerName: string): void {
  if (/No player was found|No entity was found/i.test(out)) throw httpError(404, out || `${playerName} is not online`);
  if (
    /Unknown item|Unknown slot|Unknown or incomplete command|Incorrect argument|Expected |The target inventory/i.test(
      out
    )
  ) {
    throw httpError(400, `The server rejected the command: ${out}`);
  }
}

interface GiveResult {
  player: string;
  item: string;
  count: number;
  output: string;
}

/** `/give <player> <item> <count>` via RCON. */
async function giveItem(
  serverId: string,
  playerName: string,
  itemId: string,
  count: number = 1,
  { actor = 'system' }: { actor?: string } = {}
): Promise<GiveResult> {
  assertName(playerName);
  const item = assertItemId(itemId);
  const n = Math.min(6400, Math.max(1, Math.trunc(Number(count) || 1)));
  await assertRunning(serverId, 'give items');
  const out = await rcon(serverId, 'give', playerName, item, n);
  assertRconOk(out, playerName);
  recordEvent({
    serverId,
    actor,
    type: 'player-give',
    summary: `Gave ${playerName} ${n} × ${item}`,
    details: { player: playerName, item, count: n, output: out },
  });
  return { player: playerName, item, count: n, output: out };
}

interface ClearResult {
  player: string;
  item: string | null;
  output: string;
  nothingRemoved: boolean;
}

/** `/clear <player> [item]` via RCON (no item = clear everything). */
async function clearItem(
  serverId: string,
  playerName: string,
  itemId: string | null = null,
  { actor = 'system' }: { actor?: string } = {}
): Promise<ClearResult> {
  assertName(playerName);
  const item = itemId ? assertItemId(itemId) : null;
  await assertRunning(serverId, 'clear items');
  const out = await rcon(serverId, ...(item ? ['clear', playerName, item] : ['clear', playerName]));
  assertRconOk(out, playerName);
  const nothing = /No items were found/i.test(out);
  recordEvent({
    serverId,
    actor,
    type: 'player-clear',
    summary: item ? `Cleared ${item} from ${playerName}` : `Cleared the entire inventory of ${playerName}`,
    details: { player: playerName, item, output: out, nothingRemoved: nothing },
  });
  return { player: playerName, item, output: out, nothingRemoved: nothing };
}

// ---------------------------------------------------------------------------
// God-mode slot editing.
//
// Two mechanisms, chosen automatically per edit:
//  • ONLINE (server running AND player online) → RCON `item replace entity`.
//    26.x syntax confirmed live against NeoForge 26.1.2:
//      item replace entity <p> <slot> with <id> [count]      (set / delete via minecraft:air)
//      item replace entity <p> <slot> from entity <p> <slot> (copy, keeps components)
//    Slot names: hotbar.0-8, inventory.0-26, enderchest.0-26, armor.head/
//    chest/legs/feet, weapon.offhand ("Unknown slot 'x'" on anything else).
//  • OFFLINE → direct .dat rewrite with prismarine-nbt (raw tags, NOT the
//    simplified view, so unknown modded data survives byte-for-byte). Every
//    write copies the original to <file>.msm-bak-<ts> first (last 3
//    kept) and lands via tmp-file + rename. Refused while the player is
//    online (the server would overwrite the file on its next save).

const ARMOR_PIECES = ['head', 'chest', 'legs', 'feet'];
// 1.21.5 (DataVersion 4325) moved armor/offhand into the `equipment` compound.
const EQUIPMENT_DATAVERSION = 4325;
const MAX_STACK = 99; // `item replace` count argument limit — mirrored offline

type ContainerName = 'hotbar' | 'inventory' | 'enderchest' | 'armor' | 'offhand';

interface SlotContainerDef {
  size: number;
  kind: 'list' | 'equipment';
  list?: string;
  base?: number;
  pieces?: string[];
  legacy?: number[];
  rcon: (n: number) => string;
}

const SLOT_CONTAINERS: Record<ContainerName, SlotContainerDef> = {
  hotbar: { size: 9, kind: 'list', list: 'Inventory', base: 0, rcon: (n) => `hotbar.${n}` },
  inventory: { size: 27, kind: 'list', list: 'Inventory', base: 9, rcon: (n) => `inventory.${n}` },
  enderchest: { size: 27, kind: 'list', list: 'EnderItems', base: 0, rcon: (n) => `enderchest.${n}` },
  armor: {
    size: 4,
    kind: 'equipment',
    pieces: ARMOR_PIECES,
    legacy: [103, 102, 101, 100],
    rcon: (n) => `armor.${ARMOR_PIECES[n]}`,
  },
  offhand: { size: 1, kind: 'equipment', pieces: ['offhand'], legacy: [OFFHAND_SLOT], rcon: () => 'weapon.offhand' },
};

interface SlotSpec {
  container: ContainerName;
  slot: number;
  kind: 'list' | 'equipment';
  list: string | null;
  nbtSlot: number;
  piece: string | null;
  rconSlot: string;
}

/** Validate container + slot; resolve every addressing scheme at once. */
function resolveSlot(container: string, slot: number | string): SlotSpec {
  const def = SLOT_CONTAINERS[container as ContainerName];
  if (!def) throw httpError(400, `Unknown container "${container}"`);
  const n = Math.trunc(Number(slot));
  if (!Number.isInteger(n) || n < 0 || n >= def.size) {
    throw httpError(400, `Slot ${slot} is out of range for ${container} (0-${def.size - 1})`);
  }
  return {
    container: container as ContainerName,
    slot: n,
    kind: def.kind,
    list: def.kind === 'list' ? def.list! : null,
    nbtSlot: def.kind === 'list' ? def.base! + n : def.legacy![n]!,
    piece: def.kind === 'equipment' ? def.pieces![n]! : null,
    rconSlot: def.rcon(n),
  };
}

function clampCount(count: number): number {
  return Math.min(MAX_STACK, Math.max(1, Math.trunc(Number(count) || 1)));
}

interface EditContext {
  uuid: string;
  name: string | null;
  running: boolean;
  online: boolean;
  onlineKnown: boolean;
  mechanism: 'rcon' | 'file';
}

/** Who/where/how for an edit: player name, server state, chosen mechanism. */
async function editContext(serverId: string, uuidInput: string): Promise<EditContext> {
  const uuid = assertUuid(uuidInput);
  const { byUuid } = usercacheMaps(serverId);
  const name = byUuid.get(uuid) || null;
  let running = false;
  try {
    const info = await inspectStatus(serverId);
    running = info.exists && RUNNING_STATES.has(info.status);
  } catch {
    /* docker down — file edits still possible */
  }
  let online = false;
  let onlineKnown = true;
  if (running && name) {
    try {
      const names: string[] = await require('./players').listOnlineNames(serverId, { throwOnError: true });
      online = names.some((n) => n.toLowerCase() === name.toLowerCase());
    } catch {
      // RCON hiccup: we do NOT know whether they're online. Mark it so withDatFile
      // refuses the offline file path rather than assuming offline and clobbering a live save.
      onlineKnown = false;
    }
  }
  return { uuid, name, running, online, onlineKnown, mechanism: running && online ? 'rcon' : 'file' };
}

// --------------------------------------------------------------- online path

/**
 * `save-all flush` — forces the server to rewrite every online player's .dat
 * with their LIVE state. Best-effort; the short wait lets the write land.
 */
async function flushPlayerData(serverId: string): Promise<boolean> {
  try {
    await rcon(serverId, 'save-all', 'flush');
    await new Promise((r) => setTimeout(r, 1200));
    return true;
  } catch {
    return false;
  }
}

interface DatSlotRead {
  exists: boolean;
  id?: string | null;
  count?: number;
  hasComponents?: boolean;
}

/** Read one slot straight from the .dat on disk (raw tree, no simplify). */
async function readDatSlot(serverId: string, uuid: string, spec: SlotSpec): Promise<DatSlotRead> {
  const file = path.join(playerdataDir(serverId), `${uuid}.dat`);
  const { parsed } = await nbt.parse(await fsp.readFile(file));
  const cur = offlineSlotRef(parsed.value as any, spec).get();
  if (!cur) return { exists: false };
  return {
    exists: true,
    id: rawId(cur),
    count: Number((cur.count || cur.Count || {}).value || 1),
    hasComponents: Boolean(cur.components || cur.tag),
  };
}

/**
 * Read one live slot. Primary: `data get entity` (console sender → RCON sees
 * the output). Fallback: NeoForge 26.x can fail ANY `data get entity <player>`
 * with "An unexpected error occurred" while the player is online (verified
 * live on 26.1.2) — in that case flush the live state to disk with
 * `save-all flush` and read the freshly written .dat instead.
 */
async function readSlotOnline(serverId: string, ctx: EditContext, spec: SlotSpec): Promise<DatSlotRead> {
  const nbtPath = spec.kind === 'equipment' ? `equipment.${spec.piece}` : `${spec.list}[{Slot:${spec.nbtSlot}b}]`;
  const out = await rcon(serverId, 'data', 'get', 'entity', ctx.name, nbtPath);
  if (/No entity was found|No player was found/i.test(out)) {
    throw httpError(
      409,
      `${ctx.name} just went offline — reload and try again (the edit will use the save file instead)`
    );
  }
  if (/unexpected error/i.test(out)) {
    await flushPlayerData(serverId);
    try {
      return await readDatSlot(serverId, ctx.uuid, spec);
    } catch {
      throw httpError(
        502,
        'Could not read the live inventory (this server rejects data queries and its save file is unreadable) — try again'
      );
    }
  }
  if (/Found no elements|has no|Invalid|Expected/i.test(out)) return { exists: false };
  const id = /\bid:\s*"([^"]+)"/.exec(out);
  if (!id) return { exists: false };
  const count = /\bcount:\s*(\d+)/.exec(out); // top-level count prints first in vanilla SNBT
  return {
    exists: true,
    id: id[1],
    count: count ? Number(count[1]) : 1,
    hasComponents: /\bcomponents:\s*\{/.test(out),
  };
}

interface SlotEditResult {
  item: string | null;
  count: number;
  note?: string | null;
}

async function editSlotOnline(
  serverId: string,
  ctx: EditContext,
  spec: SlotSpec,
  { op, item, count }: { op: 'set' | 'delete' | 'count'; item: string | null; count: number }
): Promise<SlotEditResult> {
  const name = ctx.name!;
  if (op === 'delete') {
    const prev = await readSlotOnline(serverId, ctx, spec);
    if (!prev.exists) throw httpError(404, `${spec.rconSlot} is already empty`);
    const out = await rcon(serverId, 'item', 'replace', 'entity', name, spec.rconSlot, 'with', 'minecraft:air');
    assertRconOk(out, name);
    return { item: prev.id ?? null, count: prev.count ?? 0, note: null };
  }
  if (op === 'set') {
    const out = await rcon(serverId, 'item', 'replace', 'entity', name, spec.rconSlot, 'with', item, count);
    assertRconOk(out, name);
    return { item, count, note: null };
  }
  // op === 'count' — re-issue the same id with the new count. `item replace`
  // always creates a fresh stack, so custom components are lost; flag it.
  const cur = await readSlotOnline(serverId, ctx, spec);
  if (!cur.exists) throw httpError(404, `${spec.rconSlot} is empty — nothing to re-count`);
  const out = await rcon(serverId, 'item', 'replace', 'entity', name, spec.rconSlot, 'with', cur.id, count);
  assertRconOk(out, name);
  return {
    item: cur.id ?? null,
    count,
    note: cur.hasComponents
      ? 'This item carried custom data (enchantments, contents, …) which a live count change resets — change counts while the player is offline to keep it.'
      : null,
  };
}

interface MoveResult {
  item: string | null;
  count: number;
  swapped: boolean;
}

async function moveSlotOnline(
  serverId: string,
  ctx: EditContext,
  fromSpec: SlotSpec,
  toSpec: SlotSpec
): Promise<MoveResult> {
  const name = ctx.name!;
  const src = await readSlotOnline(serverId, ctx, fromSpec);
  if (!src.exists) throw httpError(404, `${fromSpec.rconSlot} is empty — nothing to move`);
  const dst = await readSlotOnline(serverId, ctx, toSpec);
  if (dst.exists) {
    throw httpError(
      409,
      `${toSpec.rconSlot} is occupied — live moves need an empty target. Swaps work while the player is offline (kick them first).`
    );
  }
  // `from entity` copies the stack WITH its components, then the source is aired.
  let out = await rcon(
    serverId,
    'item',
    'replace',
    'entity',
    name,
    toSpec.rconSlot,
    'from',
    'entity',
    name,
    fromSpec.rconSlot
  );
  assertRconOk(out, name);
  out = await rcon(serverId, 'item', 'replace', 'entity', name, fromSpec.rconSlot, 'with', 'minecraft:air');
  assertRconOk(out, name);
  return { item: src.id ?? null, count: src.count ?? 0, swapped: false };
}

// -------------------------------------------------------------- offline path
// All mutation happens on the RAW prismarine-nbt tree ({type, value} tags), so
// every unknown field — modded components included — survives untouched. The
// raw tree is genuinely dynamic (arbitrary modded NBT), so it's typed `any`
// here rather than forced through prismarine-nbt's Tags union.

const tag = {
  byte: (v: number) => ({ type: 'byte', value: v }),
  int: (v: number) => ({ type: 'int', value: v }),
  string: (v: string) => ({ type: 'string', value: v }),
};

/** Fresh 1.20.5+ item stack (no components). */
function makeRawItem(id: string, count: number): any {
  return { id: tag.string(id), count: tag.int(count) };
}

/** Set an item's count, preserving the field flavor (modern int / legacy byte). */
function setRawCount(itemValue: any, count: number): void {
  if (itemValue.count) itemValue.count.value = count;
  else if (itemValue.Count) itemValue.Count.value = count;
  else itemValue.count = tag.int(count);
}

function rawId(itemValue: any): string | null {
  return itemValue && itemValue.id ? String(itemValue.id.value) : null;
}

/** Inventory/EnderItems as a mutable array of compound values (created on demand). */
function rawItemList(root: any, name: string, { create = false }: { create?: boolean } = {}): any[] | null {
  let list = root[name];
  if (!list) {
    if (!create) return null;
    list = root[name] = { type: 'list', value: { type: 'compound', value: [] } };
  }
  if (list.type !== 'list') throw httpError(422, `${name} in the player file is not a list`);
  // Empty NBT lists carry element type 'end' — retype on first insert.
  if (list.value.type === 'end' || !Array.isArray(list.value.value)) {
    list.value = { type: 'compound', value: [] };
  } else if (list.value.type !== 'compound') {
    throw httpError(422, `${name} in the player file has unexpected element type "${list.value.type}"`);
  }
  return list.value.value;
}

/** Modern layout: `equipment` present, or DataVersion >= 1.21.5. */
function usesEquipmentCompound(root: any): boolean {
  if (root.equipment && root.equipment.type === 'compound') return true;
  const dv = root.DataVersion ? Number(root.DataVersion.value) : 0;
  return dv >= EQUIPMENT_DATAVERSION;
}

interface OfflineSlotRef {
  get(): any | null;
  set(itemValue: any): void;
  remove(): void;
}

/**
 * Uniform accessor for one slot in the raw tree. get/set/remove re-scan on
 * every call so interleaved removals can never act on stale indexes.
 */
function offlineSlotRef(root: any, spec: SlotSpec): OfflineSlotRef {
  if (spec.kind === 'equipment' && usesEquipmentCompound(root)) {
    const eq = () => {
      if (!root.equipment || root.equipment.type !== 'compound') {
        root.equipment = { type: 'compound', value: {} };
      }
      return root.equipment.value;
    };
    return {
      get() {
        const piece = eq()[spec.piece!];
        return piece && piece.type === 'compound' && piece.value.id ? piece.value : null;
      },
      set(itemValue: any) {
        delete itemValue.Slot; // equipment entries carry no Slot field
        eq()[spec.piece!] = { type: 'compound', value: itemValue };
      },
      remove() {
        delete eq()[spec.piece!];
      },
    };
  }
  // List-backed (Inventory / EnderItems) — armor/offhand fall through here on
  // pre-1.21.5 saves via their legacy slot numbers.
  const listName = spec.kind === 'equipment' ? 'Inventory' : spec.list!;
  const find = (entries: any[]) => entries.findIndex((e) => e && e.Slot && Number(e.Slot.value) === spec.nbtSlot);
  return {
    get() {
      const entries = rawItemList(root, listName);
      if (!entries) return null;
      const i = find(entries);
      return i === -1 ? null : entries[i];
    },
    set(itemValue: any) {
      const entries = rawItemList(root, listName, { create: true })!;
      itemValue.Slot = tag.byte(spec.nbtSlot);
      const i = find(entries);
      if (i === -1) entries.push(itemValue);
      else entries[i] = itemValue;
    },
    remove() {
      const entries = rawItemList(root, listName);
      if (!entries) return;
      const i = find(entries);
      if (i !== -1) entries.splice(i, 1);
    },
  };
}

/** Pure slot edit on a raw root (exported for tests). Returns edit metadata. */
function applyOfflineSlotEdit(
  root: any,
  spec: SlotSpec,
  { op, item, count }: { op: 'set' | 'delete' | 'count'; item: string | null; count: number }
): SlotEditResult {
  const ref = offlineSlotRef(root, spec);
  if (op === 'set') {
    ref.set(makeRawItem(item!, count));
    return { item, count };
  }
  const cur = ref.get();
  if (!cur) throw httpError(404, `${spec.rconSlot} is empty — nothing to ${op === 'delete' ? 'delete' : 're-count'}`);
  if (op === 'delete') {
    const meta = { item: rawId(cur), count: Number((cur.count || cur.Count || {}).value || 1) };
    ref.remove();
    return meta;
  }
  setRawCount(cur, count); // op === 'count' — components untouched
  return { item: rawId(cur), count };
}

/** Pure move/swap on a raw root (exported for tests). */
function applyOfflineMove(root: any, fromSpec: SlotSpec, toSpec: SlotSpec): MoveResult {
  const fromRef = offlineSlotRef(root, fromSpec);
  const toRef = offlineSlotRef(root, toSpec);
  const src = fromRef.get();
  if (!src) throw httpError(404, `${fromSpec.rconSlot} is empty — nothing to move`);
  const dst = toRef.get();
  fromRef.remove();
  if (dst) toRef.remove();
  toRef.set(src);
  if (dst) fromRef.set(dst); // swap
  return { item: rawId(src), count: Number((src.count || src.Count || {}).value || 1), swapped: Boolean(dst) };
}

// Nested (backpack) editing — offline only. Walk the RAW tree along the same
// path detectNestedInventories reported on the simplified view (the shapes
// map 1:1: compound key <-> string segment, list index <-> number segment).

function assertNestedPath(pathSegs: unknown): (string | number)[] {
  if (!Array.isArray(pathSegs) || !pathSegs.length || pathSegs.length > NESTED_MAX_PATH) {
    throw httpError(400, 'Invalid nested inventory path');
  }
  for (const seg of pathSegs) {
    const okString = typeof seg === 'string' && NESTED_KEY_RE.test(seg);
    const okIndex = Number.isInteger(seg) && seg >= 0 && seg <= 255;
    if (!okString && !okIndex) throw httpError(400, 'Invalid nested inventory path');
  }
  return pathSegs;
}

/** Follow path segments through raw tags; returns the tag at the end. */
function walkRaw(startTag: any, pathSegs: (string | number)[]): any {
  let cur = startTag;
  for (const seg of pathSegs) {
    if (cur.type === 'compound') {
      if (typeof seg !== 'string' || !cur.value[seg])
        throw httpError(404, 'That nested inventory no longer exists — reload');
      cur = cur.value[seg];
    } else if (cur.type === 'list') {
      if (!Number.isInteger(seg) || !Array.isArray(cur.value.value) || (seg as number) >= cur.value.value.length) {
        throw httpError(404, 'That nested inventory no longer exists — reload');
      }
      cur = { type: cur.value.type, value: cur.value.value[seg as number] };
    } else {
      throw httpError(404, 'That nested inventory no longer exists — reload');
    }
  }
  return cur;
}

/** Pure nested edit on a raw root (exported for tests). */
function applyOfflineNestedEdit(
  root: any,
  spec: SlotSpec,
  {
    path: pathSegs,
    index,
    op,
    item,
    count,
  }: { path: unknown; index: number; op: 'set' | 'delete' | 'count'; item: string | null; count: number }
): SlotEditResult {
  const segs = assertNestedPath(pathSegs);
  const holder = offlineSlotRef(root, spec).get();
  if (!holder) throw httpError(404, `${spec.rconSlot} is empty — the backpack is gone. Reload.`);
  const listTag = walkRaw({ type: 'compound', value: holder }, segs);
  if (listTag.type !== 'list' || listTag.value.type !== 'compound' || !Array.isArray(listTag.value.value)) {
    throw httpError(400, 'That path does not point at an item list');
  }
  const entries = listTag.value.value;
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
    throw httpError(404, 'That nested slot no longer exists — reload');
  }
  const el = entries[index];
  // Wrapped shape {slot, item:{...}} vs direct {id, count, Slot?}.
  const wrapped = !el.id && el.item && el.item.type === 'compound' && el.item.value.id;
  const inner = wrapped ? el.item.value : el;
  if (!inner.id) throw httpError(404, 'That nested slot is empty');

  if (op === 'delete') {
    const meta = { item: rawId(inner), count: Number((inner.count || inner.Count || {}).value || 1) };
    entries.splice(index, 1);
    return meta;
  }
  if (op === 'count') {
    setRawCount(inner, count);
    return { item: rawId(inner), count };
  }
  // op === 'set' — replace with a fresh stack, keeping the element's slot marker.
  const fresh = makeRawItem(item!, count);
  if (wrapped) {
    el.item = { type: 'compound', value: fresh };
  } else {
    if (el.Slot) fresh.Slot = el.Slot;
    entries[index] = fresh;
  }
  return { item, count };
}

// .dat I/O with backups

const BAK_SUFFIX = '.msm-bak-';
const BAK_KEEP = 3;

async function backupDat(file: string): Promise<string> {
  const bak = `${file}${BAK_SUFFIX}${Date.now()}`;
  await fsp.copyFile(file, bak);
  const dir = path.dirname(file);
  const prefix = path.basename(file) + BAK_SUFFIX;
  let names: string[] = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return bak;
  }
  const baks = names
    .filter((n: string) => n.startsWith(prefix))
    .sort()
    .reverse();
  for (const old of baks.slice(BAK_KEEP)) {
    await fsp.rm(path.join(dir, old), { force: true }).catch(() => {});
  }
  return bak;
}

/**
 * Read → mutate(rawRootValue) → backup → gzip → atomic write.
 * Refused while the player is online (their live state would overwrite it).
 */
async function withDatFile<T>(serverId: string, ctx: EditContext, mutate: (root: any) => T): Promise<T> {
  if (ctx.running && ctx.onlineKnown === false) {
    throw httpError(
      409,
      `Couldn't confirm ${ctx.name || ctx.uuid} is offline (the server didn't answer) — not risking a file edit while it's running. Retry in a moment.`
    );
  }
  if (ctx.running && ctx.online) {
    throw httpError(
      409,
      `${ctx.name || ctx.uuid} is online — the server would overwrite file edits. This edit should have gone over RCON; reload and retry.`
    );
  }
  const file = path.join(playerdataDir(serverId), `${ctx.uuid}.dat`);
  // Serialize edits to the same .dat: two concurrent slot edits sharing one temp
  // path could interleave their writes and corrupt the save.
  return withDatLock(file, async () => {
    let buf: Buffer;
    try {
      buf = await fsp.readFile(file);
    } catch {
      throw httpError(404, 'No saved data for this player yet — they need to have joined the server at least once');
    }
    let parsed: import('prismarine-nbt').NBT;
    try {
      ({ parsed } = await nbt.parse(buf));
    } catch (err) {
      throw httpError(422, `Could not parse the player data file: ${(err as Error).message}`);
    }
    const result = mutate(parsed.value as any);
    await backupDat(file);
    const out = zlib.gzipSync(nbt.writeUncompressed(parsed, 'big')); // playerdata is always gzip'd big-endian
    const tmp = `${file}.msm-tmp-${process.pid}-${require('node:crypto').randomUUID()}`;
    await fsp.writeFile(tmp, out);
    await fsp.rename(tmp, file);
    return result;
  });
}

// Per-file async mutex: serializes .dat mutations for the same path so concurrent
// edits can't interleave. The tail promise is dropped from the map once its queue drains.
const datLocks = new Map<string, Promise<unknown>>();
function withDatLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = (datLocks.get(key) as Promise<T> | undefined) || Promise.resolve();
  const run = prev.then(fn, fn); // run regardless of the previous edit's outcome
  const tail = run.catch(() => {});
  datLocks.set(key, tail);
  tail.then(() => {
    if (datLocks.get(key) === tail) datLocks.delete(key);
  });
  return run;
}

// ----------------------------------------------------------- public edit API

interface EditSlotResult extends SlotEditResult {
  player: string;
  mechanism: 'rcon' | 'file';
  slot: string;
}

/**
 * Edit one slot: op 'set' (place item+count), 'delete', or 'count'.
 * `nested` = {path, index} targets a sub-inventory INSIDE the item in that
 * slot (offline mechanism only).
 */
async function editSlot(
  serverId: string,
  uuid: string,
  {
    container,
    slot,
    op,
    item = null,
    count = 1,
    nested = null,
  }: {
    container: string;
    slot: number | string;
    op: 'set' | 'delete' | 'count';
    item?: string | null;
    count?: number;
    nested?: { path: (string | number)[]; index: number } | null;
  },
  { actor = 'system' }: { actor?: string } = {}
): Promise<EditSlotResult> {
  const spec = resolveSlot(container, slot);
  if (!['set', 'delete', 'count'].includes(op)) throw httpError(400, `Unknown op "${op}"`);
  let resolvedItem = item;
  if (op === 'set') resolvedItem = assertItemId(item);
  const resolvedCount = clampCount(count);

  const ctx = await editContext(serverId, uuid);
  const playerLabel = ctx.name || ctx.uuid;
  let result: SlotEditResult;
  if (nested) {
    if (ctx.mechanism === 'rcon') {
      throw httpError(
        409,
        'Backpack contents can only be edited in the save file — stop the server or kick the player, then try again.'
      );
    }
    result = await withDatFile(serverId, ctx, (root) =>
      applyOfflineNestedEdit(root, spec, {
        path: nested.path,
        index: nested.index,
        op,
        item: resolvedItem,
        count: resolvedCount,
      })
    );
  } else if (ctx.mechanism === 'rcon') {
    result = await editSlotOnline(serverId, ctx, spec, { op, item: resolvedItem, count: resolvedCount });
  } else {
    result = await withDatFile(serverId, ctx, (root) =>
      applyOfflineSlotEdit(root, spec, { op, item: resolvedItem, count: resolvedCount })
    );
  }

  const where = nested
    ? `${spec.rconSlot} > ${nested.path.filter((s) => typeof s === 'string').pop() || 'contents'}[${nested.index}]`
    : spec.rconSlot;
  const summary =
    op === 'set'
      ? `${playerLabel}: ${result.count}x ${result.item} placed in ${where}`
      : op === 'delete'
        ? `${playerLabel}: ${result.item} removed from ${where}`
        : `${playerLabel}: ${result.item} in ${where} set to ${result.count}`;
  recordEvent({
    serverId,
    actor,
    type: 'inventory-edit',
    summary: `${summary} (${ctx.mechanism === 'rcon' ? 'live' : 'file edit'})`,
    details: {
      player: playerLabel,
      uuid: ctx.uuid,
      op,
      container,
      slot: spec.slot,
      nested,
      item: result.item,
      count: result.count,
      via: ctx.mechanism,
    },
  });
  return { ...result, player: playerLabel, mechanism: ctx.mechanism, slot: where };
}

interface MoveItemResult extends MoveResult {
  player: string;
  mechanism: 'rcon' | 'file';
  from: string;
  to: string;
}

/** Move/swap between any two slots (inventory <-> ender chest included). */
async function moveItem(
  serverId: string,
  uuid: string,
  from: { container: string; slot: number | string },
  to: { container: string; slot: number | string },
  { actor = 'system' }: { actor?: string } = {}
): Promise<MoveItemResult> {
  const fromSpec = resolveSlot(from.container, from.slot);
  const toSpec = resolveSlot(to.container, to.slot);
  if (fromSpec.rconSlot === toSpec.rconSlot) throw httpError(400, 'Source and destination are the same slot');

  const ctx = await editContext(serverId, uuid);
  const playerLabel = ctx.name || ctx.uuid;
  const result =
    ctx.mechanism === 'rcon'
      ? await moveSlotOnline(serverId, ctx, fromSpec, toSpec)
      : await withDatFile(serverId, ctx, (root) => applyOfflineMove(root, fromSpec, toSpec));

  recordEvent({
    serverId,
    actor,
    type: 'inventory-edit',
    summary: `${playerLabel}: ${result.item} ${result.swapped ? 'swapped' : 'moved'} ${fromSpec.rconSlot} -> ${toSpec.rconSlot} (${ctx.mechanism === 'rcon' ? 'live' : 'file edit'})`,
    details: {
      player: playerLabel,
      uuid: ctx.uuid,
      op: 'move',
      from,
      to,
      item: result.item,
      count: result.count,
      swapped: result.swapped,
      via: ctx.mechanism,
    },
  });
  return { ...result, player: playerLabel, mechanism: ctx.mechanism, from: fromSpec.rconSlot, to: toSpec.rconSlot };
}

interface AddItemResult {
  player: string;
  item: string;
  count: number;
  slot: number;
  mechanism: 'rcon' | 'file';
  output?: string;
}

/** Add an item to the first free hotbar/main slot — works online and offline. */
async function addItem(
  serverId: string,
  uuid: string,
  itemId: string,
  count: number = 1,
  { actor = 'system' }: { actor?: string } = {}
): Promise<AddItemResult> {
  const item = assertItemId(itemId);
  const resolvedCount = clampCount(count);
  const ctx = await editContext(serverId, uuid);
  if (ctx.mechanism === 'rcon') {
    const gave = await giveItem(serverId, ctx.name!, item, resolvedCount, { actor });
    return { ...gave, slot: -1, mechanism: 'rcon' };
  }
  const playerLabel = ctx.name || ctx.uuid;
  const slot = await withDatFile(serverId, ctx, (root) => {
    const entries = rawItemList(root, 'Inventory', { create: true })!;
    const used = new Set(entries.filter((e) => e && e.Slot).map((e) => Number(e.Slot.value)));
    let free = -1;
    for (let n = 0; n <= 35; n++) {
      if (!used.has(n)) {
        free = n;
        break;
      }
    }
    if (free === -1) throw httpError(409, 'Their inventory is full — no free slot to add into');
    entries.push({ ...makeRawItem(item, resolvedCount), Slot: tag.byte(free) });
    return free;
  });
  recordEvent({
    serverId,
    actor,
    type: 'inventory-edit',
    summary: `${playerLabel}: ${resolvedCount}x ${item} added to slot ${slot} (file edit)`,
    details: { player: playerLabel, uuid: ctx.uuid, op: 'add', item, count: resolvedCount, slot, via: 'file' },
  });
  return { player: playerLabel, item, count: resolvedCount, slot, mechanism: 'file' };
}

export = {
  readPlayerData,
  listPlayersWithData,
  searchItems,
  searchAllServers,
  snapshot,
  listSnapshots,
  getSnapshot,
  diffSnapshots,
  pruneSnapshots,
  startSnapshotWatcher,
  giveItem,
  clearItem,
  editSlot,
  moveItem,
  addItem,
  editContext,
  flushPlayerData,
  resolveSlot,
  detectNestedInventories,
  // exported for unit testing the mappers and the offline mutators
  normalizeItem,
  normalizeItemDeep,
  textComponentToString,
  applyOfflineSlotEdit,
  applyOfflineMove,
  applyOfflineNestedEdit,
};
