import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ServerQueryService } from '../servers/server-query.service';
import { ServerLocksService } from '../servers/server-locks.service';
import { EventsService } from '../events/events.service';
import { BackupsService, PRE_RESTORE_REASON } from './backups.service';
import { WorldArchiveService } from './world-archive.service';
import { WorldPropsService } from './world-props.service';
import { WorldRuntimeService } from './world-runtime.service';
import { WorldSaveLockService } from './world-save-lock.service';
import {
  chunkInhabitedTime,
  parseHeader,
  presentSlots,
  SECTOR,
} from '../utils/mca-region';
import {
  COMPANION_DIRS,
  REGION_RE,
  isRealDir,
  listRegionFolders,
  regionFileNames,
  repackRegionFile,
  type RegionFolder,
} from './world-region-files';
import type {
  DeleteChunksResult,
  WorldChunkMap,
} from '../../../shared/types/server-worlds';

/** Upper bound on one delete request (a 64x64 chunk square). */
export const MAX_DELETE_CHUNKS = 4096;

export interface ChunkCoord {
  cx: number;
  cz: number;
}

export interface DeleteChunksOptions {
  worldName: string;
  /** A `label` from {@link WorldChunkMap}. */
  dimension: string;
  chunks: ChunkCoord[];
  /** Take a `pre-restore` backup first. Defaults to true. */
  backup?: boolean;
  actor?: string;
}

const regionFileName = (rx: number, rz: number) => `r.${rx}.${rz}.mca`;
/** Chunk coordinate -> position inside its 32x32 region (0..31, also for negatives). */
const local = (c: number) => ((c % 32) + 32) % 32;

/**
 * Chunk-level view and delete for a world's Anvil region files. Deleting
 * removes the chunk from its region (and its entities / POI records);
 * Minecraft regenerates it from the seed the next time it is loaded, so
 * "delete" and "reset" are the same operation.
 *
 * Reads work on a running server. Deleting needs it stopped (the game holds
 * region data in memory and would write it back) and is serialized against
 * lifecycle ops and backups the same way {@link WorldShrinkService} is.
 */
@Injectable()
export class WorldChunksService {
  constructor(
    private readonly query: ServerQueryService,
    private readonly props: WorldPropsService,
    private readonly archive: WorldArchiveService,
    private readonly runtime: WorldRuntimeService,
    private readonly locks: ServerLocksService,
    private readonly saveLock: WorldSaveLockService,
    private readonly backups: BackupsService,
    private readonly events: EventsService,
  ) {}

  /** Which chunks exist, per dimension and region. Header reads only. */
  async listChunks(
    serverId: string,
    worldName: string,
  ): Promise<WorldChunkMap> {
    const { folders, mainDir } = await this.resolve(serverId, worldName);
    const dimensions: WorldChunkMap['dimensions'] = [];
    for (const folder of folders) {
      const regions: WorldChunkMap['dimensions'][number]['regions'] = [];
      for (const file of await regionFileNames(folder.regionDir)) {
        const [, rx, rz] = REGION_RE.exec(file) as RegExpExecArray;
        const slots = await this.readSlots(path.join(folder.regionDir, file));
        if (slots.length)
          regions.push({ rx: Number(rx), rz: Number(rz), slots });
      }
      dimensions.push({ label: folder.label, regions });
    }
    return { worldName, dimensions, spawn: await this.spawnChunk(mainDir) };
  }

  /**
   * InhabitedTime (ticks) for each of a region's 1024 slots; null where the
   * chunk is absent or can't be read.
   */
  async regionInhabited(
    serverId: string,
    worldName: string,
    dimension: string,
    rx: number,
    rz: number,
  ): Promise<Array<number | null>> {
    const { folders } = await this.resolve(serverId, worldName);
    const folder = this.pickFolder(folders, dimension);
    const file = regionFileName(rx, rz);
    if (!(await regionFileNames(folder.regionDir)).includes(file))
      throw new NotFoundException('No such region');
    const buf = await fsp.readFile(path.join(folder.regionDir, file));
    const out: Array<number | null> = new Array<number | null>(1024).fill(null);
    for (const e of parseHeader(buf)) {
      out[e.index] = await chunkInhabitedTime(buf, e);
    }
    return out;
  }

  async deleteChunks(
    serverId: string,
    opts: DeleteChunksOptions,
  ): Promise<DeleteChunksResult> {
    const { worldName, dimension } = opts;
    const actor = opts.actor ?? 'system';
    const wantBackup = opts.backup ?? true;
    if (opts.chunks.length === 0)
      throw new BadRequestException('No chunks selected');
    if (opts.chunks.length > MAX_DELETE_CHUNKS)
      throw new BadRequestException(
        `At most ${MAX_DELETE_CHUNKS} chunks can be deleted at once`,
      );

    // Fast-fail before taking any lock. Re-checked inside the critical section.
    await this.assertStopped(serverId);
    const { folders } = await this.resolve(serverId, worldName);
    const folder = this.pickFolder(folders, dimension);

    // slots to drop, grouped by region file
    const byFile = new Map<string, Set<number>>();
    for (const { cx, cz } of opts.chunks) {
      const file = regionFileName(Math.floor(cx / 32), Math.floor(cz / 32));
      let slots = byFile.get(file);
      if (!slots) byFile.set(file, (slots = new Set()));
      slots.add(local(cx) + local(cz) * 32);
    }

    return this.locks.guard(serverId, 'chunk-edit', async () => {
      // A start racing in between the fast-fail above and the file edits is
      // exactly how a live world gets torn.
      await this.assertStopped(serverId);

      // Before the save lock: createBackup takes it itself, and the lock is
      // not re-entrant.
      if (wantBackup) {
        await this.backups.createBackup(serverId, {
          reason: PRE_RESTORE_REASON,
          actor,
          note: `Safety backup before deleting chunks in "${worldName}"`,
        });
      }

      return this.saveLock.withSaveLock(serverId, async () => {
        const existing = new Set(await regionFileNames(folder.regionDir));
        let chunksRemoved = 0;
        let regionsChanged = 0;
        let regionsSkipped = 0;
        for (const [file, slots] of byFile) {
          if (!existing.has(file)) continue;
          const keep = (idx: number) => !slots.has(idx);
          let removed: number;
          try {
            removed = (
              await repackRegionFile(
                path.join(folder.regionDir, file),
                keep,
                false,
              )
            ).removed;
          } catch {
            regionsSkipped++;
            continue;
          }
          if (!removed) continue;
          chunksRemoved += removed;
          regionsChanged++;
          // Entities and POI records go with the chunk, or regenerated terrain
          // would be repopulated with the old chunk's mobs and job sites.
          for (const companion of COMPANION_DIRS) {
            const dir = path.join(path.dirname(folder.regionDir), companion);
            if (!(await isRealDir(dir))) continue;
            await repackRegionFile(path.join(dir, file), keep, false).catch(
              () => {
                /* unreadable companion: stale entities are the lesser harm */
              },
            );
          }
        }

        if (chunksRemoved > 0) {
          this.events.recordEvent({
            serverId,
            actor,
            type: 'world-chunks-deleted',
            summary: `Deleted ${chunksRemoved} chunk(s) from "${worldName}" (${dimension}).`,
            details: { worldName, dimension, chunksRemoved, regionsChanged },
          });
        }
        return {
          worldName,
          dimension,
          chunksRemoved,
          regionsChanged,
          regionsSkipped,
          backedUp: wantBackup,
        };
      });
    });
  }

  private async resolve(serverId: string, worldName: string) {
    const server = await this.query.mustGet(serverId);
    this.archive.checkWorldName(worldName);
    const tops = this.props.serverWorldDims(serverId, worldName);
    const mainDir = tops[0] as string;
    if (!(await isRealDir(mainDir)))
      throw new NotFoundException(
        `No world named "${worldName}" on server ${server.id}`,
      );
    const folders = await listRegionFolders(
      tops,
      this.archive.isDimName(worldName),
    );
    return { folders, mainDir };
  }

  /** Dimensions are addressed by a label the server itself produced, never a client path. */
  private pickFolder(folders: RegionFolder[], label: string): RegionFolder {
    const folder = folders.find((f) => f.label === label);
    if (!folder) throw new NotFoundException(`No dimension "${label}"`);
    return folder;
  }

  private async readSlots(abs: string): Promise<number[]> {
    let fh: fsp.FileHandle | undefined;
    try {
      fh = await fsp.open(abs, 'r');
      const header = Buffer.alloc(SECTOR);
      const { bytesRead } = await fh.read(header, 0, SECTOR, 0);
      return bytesRead === SECTOR ? presentSlots(header) : [];
    } catch {
      return [];
    } finally {
      await fh?.close();
    }
  }

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

  private async assertStopped(serverId: string): Promise<void> {
    if (await this.runtime.isRunning(serverId))
      throw new ConflictException(
        'Stop the server before deleting chunks. This edits the world files directly.',
      );
  }
}
