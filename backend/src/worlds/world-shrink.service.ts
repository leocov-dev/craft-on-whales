import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ServerQueryService } from '../servers/server-query.service';
import { ServerLocksService } from '../servers/server-locks.service';
import { EventsService } from '../events/events.service';
import { WorldArchiveService } from './world-archive.service';
import { WorldPropsService } from './world-props.service';
import { WorldRuntimeService } from './world-runtime.service';
import { WorldSaveLockService } from './world-save-lock.service';
import { chunkInhabitedTime, parseHeader, repack } from '../utils/mca-region';
import type { ShrinkWorldResult } from '../../../shared/types/server-worlds';

const REGION_RE = /^r\.(-?\d+)\.(-?\d+)\.mca$/;
/** Per-chunk stores that share the region grid (same file names, same slots). */
const COMPANION_DIRS = ['entities', 'poi'];
/** Overworld chunks within this many of the spawn chunk are always kept. */
export const DEFAULT_SPAWN_KEEP_CHUNKS = 8;
/** 30 seconds at 20 TPS. */
export const DEFAULT_MIN_INHABITED_TICKS = 600;
const MAX_MIN_INHABITED_TICKS = 20 * 60 * 60; // one game hour
const MAX_SPAWN_KEEP_CHUNKS = 256;

export interface ShrinkWorldOptions {
  /** Defaults to the active world. */
  worldName?: string;
  /** Keep chunks at or above this many ticks of player presence. */
  minInhabitedTicks?: number;
  /** 0 disables spawn protection. */
  spawnKeepChunks?: number;
  /** Measure only; changes nothing. */
  dryRun?: boolean;
  actor?: string;
}

interface RegionFolder {
  /** Absolute path of the `region` directory. */
  regionDir: string;
  /** Label relative to the world folder, for reporting. */
  label: string;
  /** Only the overworld gets spawn protection. */
  isOverworld: boolean;
}

interface FileOutcome {
  scanned: number;
  removed: number;
  unreadable: number;
  skipped: boolean;
  bytesBefore: number;
  bytesAfter: number;
}

const humanBytes = (n: number): string => {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(n) / Math.log(1024)),
  );
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
};

/** A real directory: symlinks are never followed out of the world folder. */
async function isRealDir(p: string): Promise<boolean> {
  try {
    return (await fsp.lstat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function realSubdirs(p: string): Promise<string[]> {
  try {
    return (await fsp.readdir(p, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Deletes region chunks almost nobody has visited (low InhabitedTime) and
 * repacks each region file so it really gets smaller; Minecraft regenerates a
 * removed chunk from the seed next time someone goes there.
 *
 * Safety rails (see WORLDS_NOTES.md): the server must be stopped for a real run
 * (a dry run only reads, so it works on a running server); overworld chunks
 * near the real spawn are kept; any chunk whose InhabitedTime can't be read is
 * kept; a dropped chunk's entities and POI records go with it; every dimension
 * is covered; files are replaced atomically; and the whole run is serialized
 * against start/stop/restart and backups.
 */
@Injectable()
export class WorldShrinkService {
  constructor(
    private readonly query: ServerQueryService,
    private readonly props: WorldPropsService,
    private readonly archive: WorldArchiveService,
    private readonly runtime: WorldRuntimeService,
    private readonly locks: ServerLocksService,
    private readonly saveLock: WorldSaveLockService,
    private readonly events: EventsService,
  ) {}

  async shrinkWorld(
    serverId: string,
    opts: ShrinkWorldOptions = {},
  ): Promise<ShrinkWorldResult> {
    const server = await this.query.mustGet(serverId);
    const minInhabitedTicks =
      Number.isFinite(opts.minInhabitedTicks) && opts.minInhabitedTicks! > 0
        ? Math.min(Math.round(opts.minInhabitedTicks!), MAX_MIN_INHABITED_TICKS)
        : DEFAULT_MIN_INHABITED_TICKS;
    const spawnKeepChunks = Number.isFinite(opts.spawnKeepChunks)
      ? Math.max(
          0,
          Math.min(Math.round(opts.spawnKeepChunks!), MAX_SPAWN_KEEP_CHUNKS),
        )
      : DEFAULT_SPAWN_KEEP_CHUNKS;
    const dryRun = Boolean(opts.dryRun);
    const actor = opts.actor ?? 'system';
    const worldName = opts.worldName ?? this.props.activeLevelName(server);
    this.archive.checkWorldName(worldName);

    // Fast-fail before taking any lock. Re-checked inside the critical section.
    if (!dryRun) await this.assertStopped(serverId);

    const main = this.props.serverWorldDims(serverId, worldName)[0] as string;
    if (!(await isRealDir(main)))
      throw new NotFoundException(
        `No world named "${worldName}" on this server`,
      );
    const folders = await this.regionFolders(serverId, worldName);
    const spawn = await this.spawnChunk(main);

    const run = async (): Promise<ShrinkWorldResult> => {
      // A start racing in between the fast-fail above and the file edits is
      // exactly how a live world gets torn.
      if (!dryRun) await this.assertStopped(serverId);
      const totals = {
        regionsScanned: 0,
        regionsSkipped: 0,
        chunksScanned: 0,
        chunksRemoved: 0,
        chunksUnreadable: 0,
        bytesFreed: 0,
      };
      const dimensions: string[] = [];

      for (const folder of folders) {
        let files: string[];
        try {
          files = (await fsp.readdir(folder.regionDir, { withFileTypes: true }))
            .filter((e) => e.isFile() && REGION_RE.test(e.name))
            .map((e) => e.name);
        } catch {
          continue;
        }
        if (files.length) dimensions.push(folder.label);
        for (const file of files) {
          const [, rx, rz] = REGION_RE.exec(file) as RegExpExecArray;
          totals.regionsScanned++;
          const r = await this.shrinkRegionFile(folder, file, {
            rx: Number(rx),
            rz: Number(rz),
            spawn,
            minInhabitedTicks,
            spawnKeepChunks,
            dryRun,
          });
          if (r.skipped) totals.regionsSkipped++;
          totals.chunksScanned += r.scanned;
          totals.chunksRemoved += r.removed;
          totals.chunksUnreadable += r.unreadable;
          totals.bytesFreed += Math.max(0, r.bytesBefore - r.bytesAfter);
        }
      }

      const result: ShrinkWorldResult = {
        worldName,
        dimensions,
        ...totals,
        dryRun,
        minInhabitedTicks,
        spawnKeepChunks,
        spawn,
      };
      if (!dryRun && totals.chunksRemoved > 0) {
        this.events.recordEvent({
          serverId,
          actor,
          type: 'world-shrunk',
          summary: `Shrank "${worldName}": removed ${totals.chunksRemoved} rarely-visited chunk(s), freed ${humanBytes(totals.bytesFreed)}.`,
          details: { ...result },
        });
      }
      return result;
    };

    if (dryRun) return run();
    // guard: no start/stop/restart/recreate (and no second shrink) can
    // interleave. saveLock: stays out of a backup/export's copy section.
    return this.locks.guard(serverId, 'shrink', () =>
      this.saveLock.withSaveLock(serverId, run),
    );
  }

  private async assertStopped(serverId: string): Promise<void> {
    if (await this.runtime.isRunning(serverId))
      throw new ConflictException(
        'Stop the server before shrinking its world. Shrinking edits the world files directly.',
      );
  }

  /**
   * Every `region` folder belonging to the world: the world dir and its
   * Bukkit-style siblings (`world_nether`, `world_the_end`), each of which may
   * hold the region folder directly or under `DIM-1` / `DIM1` /
   * `dimensions/<namespace>/<name>`.
   */
  private async regionFolders(
    serverId: string,
    worldName: string,
  ): Promise<RegionFolder[]> {
    const tops = this.props.serverWorldDims(serverId, worldName);
    const mainIsDim = this.archive.isDimName(worldName);
    const out: RegionFolder[] = [];
    const seen = new Set<string>();
    const push = async (dir: string, label: string, isOverworld: boolean) => {
      const regionDir = path.join(dir, 'region');
      // lstat only refuses a symlink in the LAST path component, so the
      // dimension folder is checked on its own as well: a symlinked `DIM1`
      // must not lead the repack outside the world.
      if (
        seen.has(regionDir) ||
        !(await isRealDir(dir)) ||
        !(await isRealDir(regionDir))
      )
        return;
      seen.add(regionDir);
      out.push({ regionDir, label, isOverworld });
    };

    for (const [i, top] of tops.entries()) {
      const prefix = i === 0 ? '' : `${path.basename(top)}/`;
      await push(
        top,
        i === 0 ? '.' : path.basename(top),
        i === 0 && !mainIsDim,
      );
      await push(path.join(top, 'DIM-1'), `${prefix}DIM-1`, false);
      await push(path.join(top, 'DIM1'), `${prefix}DIM1`, false);
      const custom = path.join(top, 'dimensions');
      for (const ns of (await isRealDir(custom))
        ? await realSubdirs(custom)
        : []) {
        for (const name of await realSubdirs(path.join(custom, ns))) {
          await push(
            path.join(custom, ns, name),
            `${prefix}dimensions/${ns}/${name}`,
            i === 0 && !mainIsDim && ns === 'minecraft' && name === 'overworld',
          );
        }
      }
    }
    return out;
  }

  /** Spawn chunk from level.dat (block coords >> 4); the origin when unreadable. */
  private async spawnChunk(mainDir: string) {
    const spawn = await this.archive.readLevelSpawn(
      path.join(mainDir, 'level.dat'),
    );
    if (!spawn) return { cx: 0, cz: 0, source: 'origin' as const };
    return {
      cx: Math.floor(spawn.x) >> 4,
      cz: Math.floor(spawn.z) >> 4,
      source: 'level.dat' as const,
    };
  }

  private async shrinkRegionFile(
    folder: RegionFolder,
    file: string,
    o: {
      rx: number;
      rz: number;
      spawn: { cx: number; cz: number };
      minInhabitedTicks: number;
      spawnKeepChunks: number;
      dryRun: boolean;
    },
  ): Promise<FileOutcome> {
    const abs = path.join(folder.regionDir, file);
    let buf: Buffer;
    try {
      buf = await fsp.readFile(abs);
    } catch {
      return this.skipped();
    }
    const entries = parseHeader(buf);
    const drop = new Set<number>();
    let unreadable = 0;
    for (const e of entries) {
      if (folder.isOverworld && o.spawnKeepChunks > 0) {
        const cx = o.rx * 32 + e.x;
        const cz = o.rz * 32 + e.z;
        if (
          Math.abs(cx - o.spawn.cx) <= o.spawnKeepChunks &&
          Math.abs(cz - o.spawn.cz) <= o.spawnKeepChunks
        )
          continue;
      }
      const ticks = await chunkInhabitedTime(buf, e);
      if (ticks === null) {
        unreadable++;
        continue;
      }
      if (ticks < o.minInhabitedTicks) drop.add(e.index);
    }

    const outcome: FileOutcome = {
      scanned: entries.length,
      removed: 0,
      unreadable,
      skipped: false,
      bytesBefore: buf.length,
      bytesAfter: buf.length,
    };
    if (!drop.size) return outcome;

    const keep = (idx: number) => !drop.has(idx);
    let region;
    try {
      region = await this.repackFile(abs, keep, o.dryRun);
    } catch {
      return { ...outcome, skipped: true, removed: 0 };
    }
    if (!region.removed) return outcome;
    outcome.removed = region.removed;
    outcome.bytesAfter = region.bytesAfter;

    // The dropped slots' entities and points of interest go with them: a chunk
    // Minecraft regenerates from the seed must not be repopulated with the old
    // chunk's mobs, item frames or villager job sites.
    for (const companion of COMPANION_DIRS) {
      const companionDir = path.join(path.dirname(folder.regionDir), companion);
      if (!(await isRealDir(companionDir))) continue;
      const sibling = path.join(companionDir, file);
      try {
        const r = await this.repackFile(sibling, keep, o.dryRun);
        outcome.bytesBefore += r.bytesBefore;
        outcome.bytesAfter += r.bytesAfter;
      } catch {
        /* companion unreadable: leave it; stale entities are the lesser harm */
      }
    }
    return outcome;
  }

  private skipped(): FileOutcome {
    return {
      scanned: 0,
      removed: 0,
      unreadable: 0,
      skipped: true,
      bytesBefore: 0,
      bytesAfter: 0,
    };
  }

  /** Rewrite (or delete) one region-format file keeping only `keep(index)` slots. */
  private async repackFile(
    abs: string,
    keep: (index: number) => boolean,
    dryRun: boolean,
  ): Promise<{ bytesBefore: number; bytesAfter: number; removed: number }> {
    let buf: Buffer;
    try {
      if (!(await fsp.lstat(abs)).isFile())
        return { bytesBefore: 0, bytesAfter: 0, removed: 0 };
      buf = await fsp.readFile(abs);
    } catch {
      return { bytesBefore: 0, bytesAfter: 0, removed: 0 };
    }
    const packed = repack(buf, keep);
    if (!packed)
      return { bytesBefore: buf.length, bytesAfter: buf.length, removed: 0 };
    const bytesAfter = packed.kept === 0 ? 0 : packed.buffer.length;
    if (!dryRun) {
      if (packed.kept === 0) {
        await fsp.rm(abs, { force: true });
      } else {
        // Temp file + rename: the file is either the old one or the new one,
        // never a partial write, even if the panel dies mid-way.
        const tmp = `${abs}.tmp`;
        try {
          await fsp.writeFile(tmp, packed.buffer);
          await fsp.rename(tmp, abs);
        } catch (err) {
          await fsp.rm(tmp, { force: true }).catch(() => {});
          throw err;
        }
      }
    }
    return { bytesBefore: buf.length, bytesAfter, removed: packed.dropped };
  }
}
