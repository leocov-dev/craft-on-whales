import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as crypto from 'node:crypto';
import * as nbt from 'prismarine-nbt';
import { PathGuardService } from '../storage/path-guard.service';
import { ServerQueryService } from '../servers/server-query.service';
import { WorldPropsService } from '../worlds/world-props.service';
import type { Server } from '../servers/types';
import { assertUuid, normalizeItemDeep, UUID_RE } from './nbt-codec';
import {
  ARMOR_SLOTS,
  OFFHAND_SLOT,
  offlineSlotRef,
  rawId,
  type SlotSpec,
} from './inventory-slots.util';
import type { NormalizedItem } from './types';
import type {
  PlayerWithData,
  PlayerInventoryData,
} from '../../../shared/types/inventory';
import type { EditContext } from './inventory-edit.service';

// Same reasoning as inventory.service.ts: this file reads/manipulates raw
// prismarine-nbt trees and untyped on-disk JSON (usercache.json etc.) —
// genuinely dynamic data, so it trades away the type-checked-member-access
// lint rules where it touches that data.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */

interface PlayerPosition {
  x: number;
  y: number;
  z: number;
  dimension: string | null;
}

/** Aggregate item counts across all sections, keyed by id + display name — shared by search and snapshot diffing. */
export function* iterateItems(
  data: PlayerInventoryData,
): Generator<[string, NormalizedItem]> {
  for (const item of data.inventory) yield ['inventory', item];
  for (const item of data.armor) yield ['armor', item];
  if (data.offhand) yield ['offhand', data.offhand];
  for (const item of data.enderChest) yield ['enderChest', item];
}

/**
 * Offline playerdata (.dat) I/O: locating the playerdata dir, parsing
 * `<uuid>.dat` into `PlayerInventoryData`, usercache.json lookups, and the
 * backed-up/locked read-mutate-write primitive (`withDatFile`) that every
 * offline slot edit goes through. Extracted from InventoryService (see
 * `.plan/reviews/05-inventory-blueprints-items.md`, "InventoryService is a
 * God class") — pure data/file layer, no RCON and no HTTP concerns.
 */
@Injectable()
export class PlayerDataFileService {
  constructor(
    private readonly pathGuard: PathGuardService,
    private readonly serverQuery: ServerQueryService,
    private readonly worldProps: WorldPropsService,
  ) {}

  // -------------------------------------------------------------- playerdata read

  async playerdataDir(serverId: string): Promise<string> {
    const server: Server | null = await this.serverQuery.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');
    const level = this.worldProps.activeLevelName(server);
    const modern = this.pathGuard.dataPath(
      'servers',
      serverId,
      level,
      'players',
      'data',
    );
    const legacy = this.pathGuard.dataPath(
      'servers',
      serverId,
      level,
      'playerdata',
    );
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
  usercacheMaps(serverId: string): {
    byUuid: Map<string, string>;
    byName: Map<string, string>;
  } {
    const byUuid = new Map<string, string>();
    const byName = new Map<string, string>();
    try {
      const raw = fs.readFileSync(
        this.pathGuard.dataPath('servers', serverId, 'usercache.json'),
        'utf8',
      );
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const e of parsed) {
          if (!e || !e.uuid || !e.name) continue;
          byUuid.set(String(e.uuid).toLowerCase(), String(e.name));
          byName.set(
            String(e.name).toLowerCase(),
            String(e.uuid).toLowerCase(),
          );
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
  async readPlayerData(
    serverId: string,
    uuidInput: string,
  ): Promise<PlayerInventoryData> {
    const uuid = assertUuid(uuidInput);
    const file = path.join(await this.playerdataDir(serverId), `${uuid}.dat`);
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(file);
    } catch {
      throw new NotFoundException(
        'No saved data for this player yet — they need to have joined the server at least once',
      );
    }

    let data: any;
    try {
      const buf = await fsp.readFile(file);
      const { parsed } = await nbt.parse(buf); // handles gzip + endianness detection
      data = nbt.simplify(parsed);
    } catch (err) {
      throw new BadRequestException(
        `Could not parse the player data file: ${(err as Error).message}`,
      );
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
    const eq =
      data.equipment && typeof data.equipment === 'object'
        ? data.equipment
        : {};
    for (const piece of ['head', 'chest', 'legs', 'feet']) {
      if (
        eq[piece] &&
        eq[piece].id !== undefined &&
        !armor.some((a) => a.piece === piece)
      ) {
        const item = normalizeItemDeep(eq[piece]);
        if (item) armor.push({ ...item, piece });
      }
    }
    if (!offhand && eq.offhand && eq.offhand.id !== undefined) {
      offhand = normalizeItemDeep(eq.offhand);
    }
    const enderChest: NormalizedItem[] = (
      Array.isArray(data.EnderItems) ? data.EnderItems : []
    )
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
      health:
        typeof data.Health === 'number'
          ? Math.round(data.Health * 10) / 10
          : null,
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
      players.push({
        uuid,
        name: byUuid.get(uuid) || null,
        lastModified: stat.mtimeMs,
      });
    }
    players.sort((a, b) => b.lastModified - a.lastModified);
    return players;
  }

  // -------------------------------------------------------------- raw .dat slot read

  /** Read one slot straight from the .dat on disk (raw tree, no simplify). */
  async readDatSlot(
    serverId: string,
    uuid: string,
    spec: SlotSpec,
  ): Promise<{
    exists: boolean;
    id?: string | null;
    count?: number;
    hasComponents?: boolean;
  }> {
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
    const prev =
      (this.datLocks.get(key) as Promise<T> | undefined) || Promise.resolve();
    const run = prev.then(fn, fn); // run regardless of the previous edit's outcome
    const tail = run.catch(() => {});
    this.datLocks.set(key, tail);
    void tail.then(() => {
      if (this.datLocks.get(key) === tail) this.datLocks.delete(key);
    });
    return run;
  }

  /**
   * Read → mutate(rawRootValue) → backup → gzip → atomic write. Refused
   * while the player is online (their live state would overwrite it).
   */
  async withDatFile<T>(
    serverId: string,
    ctx: EditContext,
    mutate: (root: any) => T,
  ): Promise<T> {
    if (ctx.running && ctx.onlineKnown === false) {
      throw new BadRequestException(
        `Couldn't confirm ${ctx.name || ctx.uuid} is offline (the server didn't answer) — not risking a file edit while it's running. Retry in a moment.`,
      );
    }
    if (ctx.running && ctx.online) {
      throw new BadRequestException(
        `${ctx.name || ctx.uuid} is online — the server would overwrite file edits. This edit should have gone over RCON; reload and retry.`,
      );
    }
    const file = path.join(
      await this.playerdataDir(serverId),
      `${ctx.uuid}.dat`,
    );
    // Serialize edits to the same .dat: two concurrent slot edits sharing one
    // temp path could interleave their writes and corrupt the save.
    return this.withDatLock(file, async () => {
      let buf: Buffer;
      try {
        buf = await fsp.readFile(file);
      } catch {
        throw new NotFoundException(
          'No saved data for this player yet — they need to have joined the server at least once',
        );
      }
      let parsed: nbt.NBT;
      try {
        ({ parsed } = await nbt.parse(buf));
      } catch (err) {
        throw new BadRequestException(
          `Could not parse the player data file: ${(err as Error).message}`,
        );
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
}
