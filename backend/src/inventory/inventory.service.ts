import { BadRequestException, forwardRef, Inject, Injectable, NotFoundException, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as crypto from 'node:crypto';
import * as nbt from 'prismarine-nbt';
import { and, gt, inArray, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { playerEvents } from '../db/schema';
import { EventsService } from '../events/events.service';
import { PathGuardService } from '../storage/path-guard.service';
import { ContainerService } from '../docker/container.service';
import { ServerQueryService } from '../servers/server-query.service';
import { WorldPropsService } from '../worlds/world-props.service';
import type { Server } from '../servers/types';
// `import type` (not a normal import) so this class doesn't join the
// synchronous require() cycle InventoryModule<->PlayersModule creates at the
// file level — PlayerTeleportService needs InventoryService (readPlayerData
// via getPlayerSavedPos) and InventoryService needs PlayerRosterService
// (listOnlineNames), so the two modules import each other. The runtime class
// reference for @Inject/forwardRef below is obtained via a lazy require()
// instead, matching the established pattern in
// servers/server-lifecycle.service.ts <-> scheduler/scheduler.service.ts.
import type { PlayerRosterService } from '../players/player-roster.service';
import { cleanText as cleanAnsiText } from '../utils/ansi';
import type { NormalizedItem } from './types';
import type { PlayerWithData, PlayerInventoryData } from '../../../shared/types/inventory';

export type { PlayerWithData, PlayerInventoryData };
import { assertUuid, assertItemId, normalizeItem, normalizeItemDeep, detectNestedInventories, UUID_RE, NAME_RE } from './nbt-codec';
import {
  ARMOR_SLOTS,
  OFFHAND_SLOT,
  resolveSlot,
  clampCount,
  makeRawItem,
  rawId,
  rawItemList,
  offlineSlotRef,
  applyOfflineSlotEdit,
  applyOfflineMove,
  applyOfflineNestedEdit,
  type SlotSpec,
  type SlotEditResult,
  type MoveResult,
} from './inventory-slots.util';

const SNAPSHOT_FILE_RE =
  /^logs\/([A-Za-z0-9_-]{1,40})\/inventories\/([0-9a-f-]{36})\/(\d{10,16})-([a-z0-9_-]{1,32})\.json$/;
const RUNNING_STATES = new Set(['running', 'unhealthy']); // rcon answers while unhealthy

interface PlayerPosition {
  x: number;
  y: number;
  z: number;
  dimension: string | null;
}


export interface ItemSearchHit {
  player: { uuid: string; name: string | null };
  where: string;
  slot: number | null;
  id: string;
  count: number;
  displayName: string | null;
}

export interface SnapshotMeta {
  file: string;
  ts: number;
  reason: string;
}

export interface SnapshotMetaWithSize extends SnapshotMeta {
  size: number;
}

export interface LoadedSnapshot extends SnapshotMeta {
  uuid: string;
  data: PlayerInventoryData;
}

interface TallyEntry {
  id: string;
  displayName: string | null;
  count: number;
}

export interface SnapshotDiff {
  a: SnapshotMeta;
  b: SnapshotMeta;
  added: TallyEntry[];
  removed: TallyEntry[];
  changed: { id: string; displayName: string | null; from: number; to: number }[];
}

export interface GiveResult {
  player: string;
  item: string;
  count: number;
  output: string;
}

export interface ClearResult {
  player: string;
  item: string | null;
  output: string;
  nothingRemoved: boolean;
}

export interface EditContext {
  uuid: string;
  name: string | null;
  running: boolean;
  online: boolean;
  onlineKnown: boolean;
  mechanism: 'rcon' | 'file';
}

export interface EditSlotResult extends SlotEditResult {
  player: string;
  mechanism: 'rcon' | 'file';
  slot: string;
}

export interface MoveItemResult extends MoveResult {
  player: string;
  mechanism: 'rcon' | 'file';
  from: string;
  to: string;
}

export interface AddItemResult {
  player: string;
  item: string;
  count: number;
  slot: number;
  mechanism: 'rcon' | 'file';
  output?: string;
}

/**
 * Inventory forensics + god-mode editing. Offline NBT inspection of
 * playerdata (.dat) files, item search across players and servers,
 * point-in-time JSON snapshots with diffing, RCON give/clear, and per-slot
 * editing (set/delete/count/move) that auto-picks its mechanism: RCON
 * `item replace entity` while the player is online, direct .dat rewrites
 * (gzip'd NBT, with rotating backups) while they are not. Ported from
 * src/services/inventory.ts.
 *
 * Genuine bidirectional cycle with PlayersModule: `editContext` needs
 * `PlayersService.listOnlineNames` (to pick the RCON-vs-file mechanism), and
 * `PlayersService`'s teleport helpers need `readPlayerData` (via
 * `getPlayerSavedPos`) — resolved with `forwardRef()` on both sides.
 *
 * SNAPSHOT STORAGE: snapshots are stored as small JSON files under
 * data/logs/<serverId>/inventories/<uuid>/<ts>-<reason>.json instead of DB
 * rows — point-in-time blobs that are never queried relationally, pruned
 * like every other log artifact, and every path resolves through
 * PathGuardService so nothing escapes the data root.
 */
@Injectable()
export class InventoryService implements OnModuleDestroy {
  private watcherTimer: NodeJS.Timeout | null = null;
  private lastEventId = 0;

  constructor(
    private readonly dbService: DbService,
    private readonly events: EventsService,
    private readonly pathGuard: PathGuardService,
    private readonly containers: ContainerService,
    private readonly serverQuery: ServerQueryService,
    private readonly worldProps: WorldPropsService,
    @Inject(forwardRef(() => require('../players/player-roster.service').PlayerRosterService))
    private readonly players: PlayerRosterService
  ) {}

  onModuleDestroy(): void {
    if (this.watcherTimer) clearInterval(this.watcherTimer);
  }

  // -------------------------------------------------------------- playerdata read

  private async playerdataDir(serverId: string): Promise<string> {
    const server: Server | null = await this.serverQuery.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');
    const level = this.worldProps.activeLevelName(server);
    const modern = this.pathGuard.dataPath('servers', serverId, level, 'players', 'data');
    const legacy = this.pathGuard.dataPath('servers', serverId, level, 'playerdata');
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
  private usercacheMaps(serverId: string): { byUuid: Map<string, string>; byName: Map<string, string> } {
    const byUuid = new Map<string, string>();
    const byName = new Map<string, string>();
    try {
      const raw = fs.readFileSync(this.pathGuard.dataPath('servers', serverId, 'usercache.json'), 'utf8');
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
  private normalizeDimension(dim: unknown): string | null {
    if (typeof dim === 'string') return dim;
    if (typeof dim === 'number' || typeof dim === 'bigint') {
      const n = Number(dim);
      if (n === -1) return 'minecraft:the_nether';
      if (n === 1) return 'minecraft:the_end';
      return 'minecraft:overworld';
    }
    return null;
  }

  /** Parse <world>/playerdata/<uuid>.dat. */
  async readPlayerData(serverId: string, uuidInput: string): Promise<PlayerInventoryData> {
    const uuid = assertUuid(uuidInput);
    const file = path.join(await this.playerdataDir(serverId), `${uuid}.dat`);
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(file);
    } catch {
      throw new NotFoundException('No saved data for this player yet — they need to have joined the server at least once');
    }

    let data: any;
    try {
      const buf = await fsp.readFile(file);
      const { parsed } = await nbt.parse(buf); // handles gzip + endianness detection
      data = nbt.simplify(parsed);
    } catch (err) {
      throw new BadRequestException(`Could not parse the player data file: ${(err as Error).message}`);
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
        dimension: this.normalizeDimension(data.Dimension),
      };
    }

    const { byUuid } = this.usercacheMaps(serverId);
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

  /** Every player with a playerdata file: [{uuid, name, lastModified}], newest first. */
  async listPlayersWithData(serverId: string): Promise<PlayerWithData[]> {
    const dir = await this.playerdataDir(serverId);
    let entries: fs.Dirent[] = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return []; // world not generated yet — nobody has joined
    }
    const { byUuid } = this.usercacheMaps(serverId);
    const players: PlayerWithData[] = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.dat')) continue; // skips .dat_old backups
      const uuid = e.name.slice(0, -4).toLowerCase();
      if (!UUID_RE.test(uuid)) continue;
      let stat: fs.Stats;
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

  // -------------------------------------------------------------- item search

  private *iterateItems(data: PlayerInventoryData): Generator<[string, NormalizedItem]> {
    for (const item of data.inventory) yield ['inventory', item];
    for (const item of data.armor) yield ['armor', item];
    if (data.offhand) yield ['offhand', data.offhand];
    for (const item of data.enderChest) yield ['enderChest', item];
  }

  /**
   * Scan every playerdata file for items whose id or display name contains
   * `query` (case-insensitive). Unreadable files are skipped, never fatal.
   */
  async searchItems(serverId: string, query: string | null | undefined, { limit = 500 }: { limit?: number } = {}): Promise<ItemSearchHit[]> {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const results: ItemSearchHit[] = [];
    for (const player of await this.listPlayersWithData(serverId)) {
      let data: PlayerInventoryData;
      try {
        data = await this.readPlayerData(serverId, player.uuid);
      } catch {
        continue; // corrupt or in-flight write — skip this player
      }
      for (const [where, item] of this.iterateItems(data)) {
        const matches = item.id.toLowerCase().includes(q) || (item.displayName && item.displayName.toLowerCase().includes(q));
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
  async searchAllServers(query: string | null | undefined, { limit = 500 }: { limit?: number } = {}): Promise<(ItemSearchHit & { serverId: string; serverName: string })[]> {
    const results: (ItemSearchHit & { serverId: string; serverName: string })[] = [];
    for (const server of await this.serverQuery.listServers()) {
      if (results.length >= limit) break;
      let hits: ItemSearchHit[] = [];
      try {
        hits = await this.searchItems(server.id, query, { limit: limit - results.length });
      } catch {
        continue; // one bad server must not sink the global search
      }
      for (const hit of hits) {
        results.push({ serverId: server.id, serverName: server.display_name, ...hit });
      }
    }
    return results;
  }

  // -------------------------------------------------------------- snapshots

  private snapshotDir(serverId: string, uuid: string): string {
    return this.pathGuard.dataPath('logs', serverId, 'inventories', assertUuid(uuid));
  }

  private cleanReason(reason: string | null | undefined): string {
    const r = String(reason || 'manual')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .slice(0, 32);
    return r || 'manual';
  }

  /** Write the current readPlayerData result to a timestamped snapshot file. */
  async snapshot(serverId: string, uuid: string, reason: string = 'manual'): Promise<SnapshotMeta> {
    const data = await this.readPlayerData(serverId, uuid);
    const dir = this.snapshotDir(serverId, uuid);
    await fsp.mkdir(dir, { recursive: true });
    let ts = Date.now();
    while (fs.existsSync(path.join(dir, `${ts}-${this.cleanReason(reason)}.json`))) ts += 1; // same-ms collision
    const name = `${ts}-${this.cleanReason(reason)}.json`;
    await fsp.writeFile(path.join(dir, name), JSON.stringify({ ts, reason: this.cleanReason(reason), serverId, data }, null, 2));
    return {
      file: path.posix.join('logs', serverId, 'inventories', data.uuid, name),
      ts,
      reason: this.cleanReason(reason),
    };
  }

  /** Snapshots for one player, newest first (metadata parsed from filenames). */
  async listSnapshots(serverId: string, uuidInput: string): Promise<SnapshotMetaWithSize[]> {
    const uuid = assertUuid(uuidInput);
    const dir = this.snapshotDir(serverId, uuid);
    let entries: fs.Dirent[] = [];
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

  /** Load one snapshot by its rel path (strict shape check + path guard). */
  getSnapshot(relFile: string): LoadedSnapshot {
    const m = SNAPSHOT_FILE_RE.exec(String(relFile || ''));
    if (!m) throw new BadRequestException('Invalid snapshot file reference');
    let raw: string;
    try {
      raw = fs.readFileSync(this.pathGuard.dataPath(relFile), 'utf8'); // dataPath re-guards containment
    } catch {
      throw new NotFoundException('Snapshot not found — it may have been pruned');
    }
    try {
      const parsed = JSON.parse(raw);
      return { file: relFile, ts: Number(m[3]), reason: m[4]!, uuid: m[2]!, data: parsed.data || parsed };
    } catch {
      throw new BadRequestException('Snapshot file is corrupt');
    }
  }

  /** Aggregate item counts across all sections, keyed by id + display name. */
  private tallyItems(data: PlayerInventoryData): Map<string, TallyEntry> {
    const tally = new Map<string, TallyEntry>();
    for (const [, item] of this.iterateItems(data)) {
      const key = `${item.id} ${item.displayName || ''}`;
      const cur = tally.get(key);
      if (cur) cur.count += item.count;
      else tally.set(key, { id: item.id, displayName: item.displayName || null, count: item.count });
    }
    return tally;
  }

  /**
   * Diff two snapshots (rel paths). Items are keyed by id + displayName so a
   * renamed item counts as its own line.
   */
  diffSnapshots(aFile: string, bFile: string): SnapshotDiff {
    const a = this.getSnapshot(aFile);
    const b = this.getSnapshot(bFile);
    const before = this.tallyItems(a.data);
    const after = this.tallyItems(b.data);

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
  async pruneSnapshots(serverId: string, keepPerPlayer: number = 50): Promise<{ pruned: number }> {
    const base = this.pathGuard.dataPath('logs', serverId, 'inventories');
    let uuids: string[] = [];
    try {
      uuids = (await fsp.readdir(base, { withFileTypes: true })).filter((e) => e.isDirectory() && UUID_RE.test(e.name)).map((e) => e.name);
    } catch {
      return { pruned: 0 };
    }
    let pruned = 0;
    for (const uuid of uuids) {
      const snapshots = await this.listSnapshots(serverId, uuid);
      for (const snap of snapshots.slice(keepPerPlayer)) {
        try {
          await fsp.rm(this.pathGuard.dataPath(snap.file), { force: true });
          pruned += 1;
        } catch {
          /* already gone */
        }
      }
    }
    return { pruned };
  }

  // -------------------------------------------------------------- automatic snapshots

  /**
   * Poll player_events every `intervalMs` for new join/death rows and
   * snapshot that player's inventory. Starts from MAX(id) so old history is
   * never replayed. All errors are contained — the watcher can never crash
   * the panel. Called from onModuleInit (see InventoryModule wiring).
   */
  startSnapshotWatcher({ intervalMs = 20000 }: { intervalMs?: number } = {}): void {
    if (this.watcherTimer) return;
    this.dbService.db
      .select({ maxId: sql<number | null>`MAX(id)` })
      .from(playerEvents)
      .then(([row]) => {
        this.lastEventId = Number(row && row.maxId) || 0;
      })
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[inventory] snapshot watcher init failed:', err instanceof Error ? err.message : String(err));
        this.lastEventId = 0;
      });
    this.watcherTimer = setInterval(() => {
      this.pollPlayerEvents().catch((err: Error) => console.error('[inventory] snapshot watcher:', err.message));
    }, intervalMs);
    this.watcherTimer.unref();
  }

  private async pollPlayerEvents(): Promise<void> {
    const rows = await this.dbService.db
      .select({ id: playerEvents.id, serverId: playerEvents.serverId, type: playerEvents.type, player: playerEvents.player })
      .from(playerEvents)
      .where(and(gt(playerEvents.id, this.lastEventId), inArray(playerEvents.type, ['join', 'death'])))
      .orderBy(playerEvents.id)
      .limit(200);
    for (const row of rows) {
      this.lastEventId = Math.max(this.lastEventId, Number(row.id));
      const player = row.player == null ? null : String(row.player);
      if (!player || !NAME_RE.test(player)) continue;
      try {
        const serverId = String(row.serverId);
        const { byName } = this.usercacheMaps(serverId);
        const uuid = byName.get(player.toLowerCase());
        if (!uuid) continue; // never joined far enough to be cached
        if (!fs.existsSync(path.join(await this.playerdataDir(serverId), `${uuid}.dat`))) continue; // no .dat yet
        await this.snapshot(serverId, uuid, String(row.type));
        await this.pruneSnapshots(serverId);
      } catch {
        // One failed snapshot (corrupt file, deleted server, …) must not stop the sweep.
      }
    }
  }

  // -------------------------------------------------------------- RCON give/clear

  private async assertRunning(serverId: string, what: string): Promise<void> {
    let info: Awaited<ReturnType<ContainerService['inspectStatus']>>;
    try {
      info = await this.containers.inspectStatus(serverId);
    } catch {
      throw new ServiceUnavailableException(`Docker is not reachable — cannot ${what}`);
    }
    if (!info.exists || !RUNNING_STATES.has(info.status)) {
      throw new BadRequestException(`The server must be running to ${what} — item edits on stopped servers are out of scope (offline data is read-only)`);
    }
  }

  private async rcon(serverId: string, ...args: unknown[]): Promise<string> {
    // '--' terminates flag parsing so args like '-106' can never become flags.
    const out = await this.containers.execCapture(serverId, ['rcon-cli', '--', ...args.map(String)]);
    return cleanAnsiText(String(out || '')).trim();
  }

  /** Surface the server's own error text on command failures. */
  private assertRconOk(out: string, playerName: string): void {
    if (/No player was found|No entity was found/i.test(out)) throw new NotFoundException(out || `${playerName} is not online`);
    if (/Unknown item|Unknown slot|Unknown or incomplete command|Incorrect argument|Expected |The target inventory/i.test(out)) {
      throw new BadRequestException(`The server rejected the command: ${out}`);
    }
  }

  /** `/give <player> <item> <count>` via RCON. */
  async giveItem(serverId: string, playerName: string, itemId: string, count: number = 1, { actor = 'system' }: { actor?: string } = {}): Promise<GiveResult> {
    const item = assertItemId(itemId);
    const n = Math.min(6400, Math.max(1, Math.trunc(Number(count) || 1)));
    await this.assertRunning(serverId, 'give items');
    const out = await this.rcon(serverId, 'give', playerName, item, n);
    this.assertRconOk(out, playerName);
    this.events.recordEvent({
      serverId,
      actor,
      type: 'player-give',
      summary: `Gave ${playerName} ${n} × ${item}`,
      details: { player: playerName, item, count: n, output: out },
    });
    return { player: playerName, item, count: n, output: out };
  }

  /** `/clear <player> [item]` via RCON (no item = clear everything). */
  async clearItem(serverId: string, playerName: string, itemId: string | null = null, { actor = 'system' }: { actor?: string } = {}): Promise<ClearResult> {
    const item = itemId ? assertItemId(itemId) : null;
    await this.assertRunning(serverId, 'clear items');
    const out = await this.rcon(serverId, ...(item ? ['clear', playerName, item] : ['clear', playerName]));
    this.assertRconOk(out, playerName);
    const nothing = /No items were found/i.test(out);
    this.events.recordEvent({
      serverId,
      actor,
      type: 'player-clear',
      summary: item ? `Cleared ${item} from ${playerName}` : `Cleared the entire inventory of ${playerName}`,
      details: { player: playerName, item, output: out, nothingRemoved: nothing },
    });
    return { player: playerName, item, output: out, nothingRemoved: nothing };
  }

  // -------------------------------------------------------------- god-mode edit context

  /** Who/where/how for an edit: player name, server state, chosen mechanism. */
  async editContext(serverId: string, uuidInput: string): Promise<EditContext> {
    const uuid = assertUuid(uuidInput);
    const { byUuid } = this.usercacheMaps(serverId);
    const name = byUuid.get(uuid) || null;
    let running = false;
    try {
      const info = await this.containers.inspectStatus(serverId);
      running = info.exists && RUNNING_STATES.has(info.status);
    } catch {
      /* docker down — file edits still possible */
    }
    let online = false;
    let onlineKnown = true;
    if (running && name) {
      try {
        const names = await this.players.listOnlineNames(serverId, { throwOnError: true });
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
   * `save-all flush` — forces the server to rewrite every online player's
   * .dat with their LIVE state. Best-effort; the short wait lets the write
   * land.
   */
  async flushPlayerData(serverId: string): Promise<boolean> {
    try {
      await this.rcon(serverId, 'save-all', 'flush');
      await new Promise((r) => setTimeout(r, 1200));
      return true;
    } catch {
      return false;
    }
  }

  /** Read one slot straight from the .dat on disk (raw tree, no simplify). */
  private async readDatSlot(serverId: string, uuid: string, spec: SlotSpec): Promise<{ exists: boolean; id?: string | null; count?: number; hasComponents?: boolean }> {
    const file = path.join(await this.playerdataDir(serverId), `${uuid}.dat`);
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
   * Read one live slot. Primary: `data get entity` (console sender → RCON
   * sees the output). Fallback: NeoForge 26.x can fail ANY
   * `data get entity <player>` with "An unexpected error occurred" while the
   * player is online — in that case flush the live state to disk with
   * `save-all flush` and read the freshly written .dat instead.
   */
  private async readSlotOnline(serverId: string, ctx: EditContext, spec: SlotSpec): Promise<{ exists: boolean; id?: string | null; count?: number; hasComponents?: boolean }> {
    const nbtPath = spec.kind === 'equipment' ? `equipment.${spec.piece}` : `${spec.list}[{Slot:${spec.nbtSlot}b}]`;
    const out = await this.rcon(serverId, 'data', 'get', 'entity', ctx.name, nbtPath);
    if (/No entity was found|No player was found/i.test(out)) {
      throw new BadRequestException(`${ctx.name} just went offline — reload and try again (the edit will use the save file instead)`);
    }
    if (/unexpected error/i.test(out)) {
      await this.flushPlayerData(serverId);
      try {
        return await this.readDatSlot(serverId, ctx.uuid, spec);
      } catch {
        throw new BadRequestException('Could not read the live inventory (this server rejects data queries and its save file is unreadable) — try again');
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

  private async editSlotOnline(serverId: string, ctx: EditContext, spec: SlotSpec, { op, item, count }: { op: 'set' | 'delete' | 'count'; item: string | null; count: number }): Promise<SlotEditResult> {
    const name = ctx.name!;
    if (op === 'delete') {
      const prev = await this.readSlotOnline(serverId, ctx, spec);
      if (!prev.exists) throw new NotFoundException(`${spec.rconSlot} is already empty`);
      const out = await this.rcon(serverId, 'item', 'replace', 'entity', name, spec.rconSlot, 'with', 'minecraft:air');
      this.assertRconOk(out, name);
      return { item: prev.id ?? null, count: prev.count ?? 0, note: null };
    }
    if (op === 'set') {
      const out = await this.rcon(serverId, 'item', 'replace', 'entity', name, spec.rconSlot, 'with', item, count);
      this.assertRconOk(out, name);
      return { item, count, note: null };
    }
    // op === 'count' — re-issue the same id with the new count. `item replace`
    // always creates a fresh stack, so custom components are lost; flag it.
    const cur = await this.readSlotOnline(serverId, ctx, spec);
    if (!cur.exists) throw new NotFoundException(`${spec.rconSlot} is empty — nothing to re-count`);
    const out = await this.rcon(serverId, 'item', 'replace', 'entity', name, spec.rconSlot, 'with', cur.id, count);
    this.assertRconOk(out, name);
    return {
      item: cur.id ?? null,
      count,
      note: cur.hasComponents
        ? 'This item carried custom data (enchantments, contents, …) which a live count change resets — change counts while the player is offline to keep it.'
        : null,
    };
  }

  private async moveSlotOnline(serverId: string, ctx: EditContext, fromSpec: SlotSpec, toSpec: SlotSpec): Promise<MoveResult> {
    const name = ctx.name!;
    const src = await this.readSlotOnline(serverId, ctx, fromSpec);
    if (!src.exists) throw new NotFoundException(`${fromSpec.rconSlot} is empty — nothing to move`);
    const dst = await this.readSlotOnline(serverId, ctx, toSpec);
    if (dst.exists) {
      throw new BadRequestException(`${toSpec.rconSlot} is occupied — live moves need an empty target. Swaps work while the player is offline (kick them first).`);
    }
    // `from entity` copies the stack WITH its components, then the source is aired.
    let out = await this.rcon(serverId, 'item', 'replace', 'entity', name, toSpec.rconSlot, 'from', 'entity', name, fromSpec.rconSlot);
    this.assertRconOk(out, name);
    out = await this.rcon(serverId, 'item', 'replace', 'entity', name, fromSpec.rconSlot, 'with', 'minecraft:air');
    this.assertRconOk(out, name);
    return { item: src.id ?? null, count: src.count ?? 0, swapped: false };
  }

  // -------------------------------------------------------------- .dat I/O with backups

  private readonly BAK_SUFFIX = '.msm-bak-';
  private readonly BAK_KEEP = 3;

  private async backupDat(file: string): Promise<string> {
    const bak = `${file}${this.BAK_SUFFIX}${Date.now()}`;
    await fsp.copyFile(file, bak);
    const dir = path.dirname(file);
    const prefix = path.basename(file) + this.BAK_SUFFIX;
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
    for (const old of baks.slice(this.BAK_KEEP)) {
      await fsp.rm(path.join(dir, old), { force: true }).catch(() => {});
    }
    return bak;
  }

  // Per-file async mutex: serializes .dat mutations for the same path so
  // concurrent edits can't interleave. The tail promise is dropped from the
  // map once its queue drains.
  private readonly datLocks = new Map<string, Promise<unknown>>();
  private withDatLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = (this.datLocks.get(key) as Promise<T> | undefined) || Promise.resolve();
    const run = prev.then(fn, fn); // run regardless of the previous edit's outcome
    const tail = run.catch(() => {});
    this.datLocks.set(key, tail);
    tail.then(() => {
      if (this.datLocks.get(key) === tail) this.datLocks.delete(key);
    });
    return run;
  }

  /**
   * Read → mutate(rawRootValue) → backup → gzip → atomic write. Refused
   * while the player is online (their live state would overwrite it).
   */
  private async withDatFile<T>(serverId: string, ctx: EditContext, mutate: (root: any) => T): Promise<T> {
    if (ctx.running && ctx.onlineKnown === false) {
      throw new BadRequestException(`Couldn't confirm ${ctx.name || ctx.uuid} is offline (the server didn't answer) — not risking a file edit while it's running. Retry in a moment.`);
    }
    if (ctx.running && ctx.online) {
      throw new BadRequestException(`${ctx.name || ctx.uuid} is online — the server would overwrite file edits. This edit should have gone over RCON; reload and retry.`);
    }
    const file = path.join(await this.playerdataDir(serverId), `${ctx.uuid}.dat`);
    // Serialize edits to the same .dat: two concurrent slot edits sharing one
    // temp path could interleave their writes and corrupt the save.
    return this.withDatLock(file, async () => {
      let buf: Buffer;
      try {
        buf = await fsp.readFile(file);
      } catch {
        throw new NotFoundException('No saved data for this player yet — they need to have joined the server at least once');
      }
      let parsed: nbt.NBT;
      try {
        ({ parsed } = await nbt.parse(buf));
      } catch (err) {
        throw new BadRequestException(`Could not parse the player data file: ${(err as Error).message}`);
      }
      const result = mutate(parsed.value as any);
      await this.backupDat(file);
      const out = zlib.gzipSync(nbt.writeUncompressed(parsed, 'big')); // playerdata is always gzip'd big-endian
      const tmp = `${file}.msm-tmp-${process.pid}-${crypto.randomUUID()}`;
      await fsp.writeFile(tmp, out);
      await fsp.rename(tmp, file);
      return result;
    });
  }

  // ----------------------------------------------------------- public edit API

  /**
   * Edit one slot: op 'set' (place item+count), 'delete', or 'count'.
   * `nested` = {path, index} targets a sub-inventory INSIDE the item in that
   * slot (offline mechanism only).
   */
  async editSlot(
    serverId: string,
    uuid: string,
    {
      container,
      slot,
      op,
      item = null,
      count = 1,
      nested = null,
    }: { container: string; slot: number | string; op: 'set' | 'delete' | 'count'; item?: string | null; count?: number; nested?: { path: (string | number)[]; index: number } | null },
    { actor = 'system' }: { actor?: string } = {}
  ): Promise<EditSlotResult> {
    const spec = resolveSlot(container, slot);
    if (!['set', 'delete', 'count'].includes(op)) throw new BadRequestException(`Unknown op "${op}"`);
    let resolvedItem = item;
    if (op === 'set') resolvedItem = assertItemId(item);
    const resolvedCount = clampCount(count);

    const ctx = await this.editContext(serverId, uuid);
    const playerLabel = ctx.name || ctx.uuid;
    let result: SlotEditResult;
    if (nested) {
      if (ctx.mechanism === 'rcon') {
        throw new BadRequestException('Backpack contents can only be edited in the save file — stop the server or kick the player, then try again.');
      }
      result = await this.withDatFile(serverId, ctx, (root) =>
        applyOfflineNestedEdit(root, spec, { path: nested.path, index: nested.index, op, item: resolvedItem, count: resolvedCount })
      );
    } else if (ctx.mechanism === 'rcon') {
      result = await this.editSlotOnline(serverId, ctx, spec, { op, item: resolvedItem, count: resolvedCount });
    } else {
      result = await this.withDatFile(serverId, ctx, (root) => applyOfflineSlotEdit(root, spec, { op, item: resolvedItem, count: resolvedCount }));
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
    this.events.recordEvent({
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

  /** Move/swap between any two slots (inventory <-> ender chest included). */
  async moveItem(serverId: string, uuid: string, from: { container: string; slot: number | string }, to: { container: string; slot: number | string }, { actor = 'system' }: { actor?: string } = {}): Promise<MoveItemResult> {
    const fromSpec = resolveSlot(from.container, from.slot);
    const toSpec = resolveSlot(to.container, to.slot);
    if (fromSpec.rconSlot === toSpec.rconSlot) throw new BadRequestException('Source and destination are the same slot');

    const ctx = await this.editContext(serverId, uuid);
    const playerLabel = ctx.name || ctx.uuid;
    const result = ctx.mechanism === 'rcon' ? await this.moveSlotOnline(serverId, ctx, fromSpec, toSpec) : await this.withDatFile(serverId, ctx, (root) => applyOfflineMove(root, fromSpec, toSpec));

    this.events.recordEvent({
      serverId,
      actor,
      type: 'inventory-edit',
      summary: `${playerLabel}: ${result.item} ${result.swapped ? 'swapped' : 'moved'} ${fromSpec.rconSlot} -> ${toSpec.rconSlot} (${ctx.mechanism === 'rcon' ? 'live' : 'file edit'})`,
      details: { player: playerLabel, uuid: ctx.uuid, op: 'move', from, to, item: result.item, count: result.count, swapped: result.swapped, via: ctx.mechanism },
    });
    return { ...result, player: playerLabel, mechanism: ctx.mechanism, from: fromSpec.rconSlot, to: toSpec.rconSlot };
  }

  /** Add an item to the first free hotbar/main slot — works online and offline. */
  async addItem(serverId: string, uuid: string, itemId: string, count: number = 1, { actor = 'system' }: { actor?: string } = {}): Promise<AddItemResult> {
    const item = assertItemId(itemId);
    const resolvedCount = clampCount(count);
    const ctx = await this.editContext(serverId, uuid);
    if (ctx.mechanism === 'rcon') {
      const gave = await this.giveItem(serverId, ctx.name!, item, resolvedCount, { actor });
      return { ...gave, slot: -1, mechanism: 'rcon' };
    }
    const playerLabel = ctx.name || ctx.uuid;
    const slot = await this.withDatFile(serverId, ctx, (root) => {
      const entries = rawItemList(root, 'Inventory', { create: true })!;
      const used = new Set(entries.filter((e) => e && e.Slot).map((e) => Number(e.Slot.value)));
      let free = -1;
      for (let n = 0; n <= 35; n++) {
        if (!used.has(n)) {
          free = n;
          break;
        }
      }
      if (free === -1) throw new BadRequestException('Their inventory is full — no free slot to add into');
      entries.push({ ...makeRawItem(item, resolvedCount), Slot: { type: 'byte', value: free } });
      return free;
    });
    this.events.recordEvent({
      serverId,
      actor,
      type: 'inventory-edit',
      summary: `${playerLabel}: ${resolvedCount}x ${item} added to slot ${slot} (file edit)`,
      details: { player: playerLabel, uuid: ctx.uuid, op: 'add', item, count: resolvedCount, slot, via: 'file' },
    });
    return { player: playerLabel, item, count: resolvedCount, slot, mechanism: 'file' };
  }
}
