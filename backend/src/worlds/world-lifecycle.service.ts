import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ServerQueryService } from '../servers/server-query.service';
import { ServerLifecycleService } from '../servers/server-lifecycle.service';
import { PathGuardService } from '../storage/path-guard.service';
import { StorageIndexService } from '../storage/storage-index.service';
import { EventsService } from '../events/events.service';
import { WorldArchiveService } from './world-archive.service';
import { WorldPropsService } from './world-props.service';
import { BackupsService } from './backups.service';
import { WorldRuntimeService } from './world-runtime.service';

const LEVEL_TYPES = new Set(['DEFAULT', 'FLAT', 'LARGEBIOMES', 'AMPLIFIED']);

export interface ResetWorldOptions {
  seedMode?: 'keep' | 'random' | 'custom';
  seed?: string;
  levelType?: string;
  backup?: boolean;
  actor?: string;
}

export interface ResetWorldResult {
  level: string;
  seedMode: string;
  keptSeed: string | null;
  seed: string | null;
  levelType: string | null;
  freedBytes: number;
}

/**
 * In-place world lifecycle workflows on an already-installed world: rename,
 * activate (switch level-name), reset (re-roll), and delete. Grouped
 * together because none of them go through the library or involve zipping —
 * they only ever move/wipe an existing world's dirs on its own server and
 * (for reset) touch server env, so they share `WorldRuntimeService`'s
 * running-check but not the transfer workflows' quota/zip machinery.
 */
@Injectable()
export class WorldLifecycleService {
  constructor(
    private readonly query: ServerQueryService,
    private readonly lifecycle: ServerLifecycleService,
    private readonly pathGuard: PathGuardService,
    private readonly indexer: StorageIndexService,
    private readonly events: EventsService,
    private readonly archive: WorldArchiveService,
    private readonly props: WorldPropsService,
    private readonly backups: BackupsService,
    private readonly runtime: WorldRuntimeService,
  ) {}

  /** Rename a world (server must be stopped); updates level-name/LEVEL when active. */
  async renameWorld(
    serverId: string,
    worldName: string,
    newName: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<{ name: string; wasActive: boolean }> {
    const server = await this.query.mustGet(serverId);
    this.archive.checkWorldName(worldName);
    const clean = this.archive.sanitizeWorldName(newName);
    if (await this.runtime.isRunning(serverId))
      throw new ConflictException('Stop the server before renaming worlds');
    const dims = this.props.serverWorldDims(serverId, worldName);
    if (!fs.existsSync(dims[0] as string))
      throw new NotFoundException(
        `No world named "${worldName}" on this server`,
      );
    if (fs.existsSync(this.pathGuard.dataPath('servers', serverId, clean))) {
      throw new ConflictException(
        `A world named "${clean}" already exists on this server`,
      );
    }

    for (const dim of dims) {
      const suffix = path.basename(dim).slice(worldName.length);
      await this.archive.moveEntry(
        dim,
        this.pathGuard.dataPath('servers', serverId, clean + suffix),
      );
    }

    const wasActive = worldName === this.props.activeLevelName(server);
    if (wasActive) await this.props.setActiveLevel(server, clean, { actor });

    this.events.recordEvent({
      serverId,
      actor,
      type: 'world-renamed',
      summary: `World "${worldName}" renamed to "${clean}"${wasActive ? ' (active world — level-name updated)' : ''}`,
      details: { from: worldName, to: clean, wasActive },
    });
    return { name: clean, wasActive };
  }

  /** Make a world the active one (sets level-name / LEVEL). Server must be stopped. */
  async activateWorld(
    serverId: string,
    worldName: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<{ active: string; changed: boolean }> {
    const server = await this.query.mustGet(serverId);
    this.archive.checkWorldName(worldName);
    if (await this.runtime.isRunning(serverId))
      throw new ConflictException('Stop the server before switching worlds');
    if (
      !fs.existsSync(
        this.pathGuard.dataPath('servers', serverId, worldName, 'level.dat'),
      )
    ) {
      throw new NotFoundException(
        `No world named "${worldName}" on this server`,
      );
    }
    const previous = this.props.activeLevelName(server);
    if (previous === worldName) return { active: worldName, changed: false };
    await this.props.setActiveLevel(server, worldName, { actor });
    this.events.recordEvent({
      serverId,
      actor,
      type: 'world-activated',
      summary: `Active world switched: "${previous}" → "${worldName}"`,
      details: { from: previous, to: worldName },
    });
    return { active: worldName, changed: true };
  }

  /**
   * Reset (re-roll) the active world: optional auto-backup, delete its
   * dirs, and regenerate on next start with full control over seed/type.
   * Server must be stopped.
   */
  async resetWorld(
    serverId: string,
    {
      seedMode = 'random',
      seed = '',
      levelType = '',
      backup = true,
      actor = 'system',
    }: ResetWorldOptions = {},
  ): Promise<ResetWorldResult> {
    const server = await this.query.mustGet(serverId);
    if (await this.runtime.isRunning(serverId))
      throw new ConflictException('Stop the server before resetting the world');
    const level = this.props.activeLevelName(server);
    const dims = this.props.serverWorldDims(serverId, level);
    if (!fs.existsSync(dims[0] as string))
      throw new NotFoundException(
        `World "${level}" does not exist yet — nothing to reset`,
      );

    let newSeed: string | null = null;
    if (seedMode === 'keep') {
      newSeed =
        this.props.readProps(serverId).get('level-seed') ||
        this.archive.readLevelSeed(path.join(dims[0] as string, 'level.dat')) ||
        null;
    } else if (seedMode === 'custom') {
      newSeed = String(seed || '').trim() || null;
    }
    const applyType = LEVEL_TYPES.has(levelType) ? levelType : '';

    if (backup) {
      await this.backups.createBackup(serverId, {
        reason: 'manual',
        actor,
        note: `Safety backup before resetting world "${level}"`,
      });
    }

    const freedBytes = await this.archive.dirsSize(dims);
    for (const dim of dims) await fsp.rm(dim, { recursive: true, force: true });

    const env: Record<string, string> = { ...server.env };
    if (newSeed) {
      this.props.setProp(serverId, 'level-seed', String(newSeed));
      env.SEED = String(newSeed);
    } else {
      this.props.setProp(serverId, 'level-seed', '');
      delete env.SEED;
    }
    if (applyType) env.LEVEL_TYPE = applyType;
    if (JSON.stringify(env) !== JSON.stringify(server.env)) {
      await this.lifecycle.updateServer(serverId, { env }, { actor });
    }

    const seedNote =
      seedMode === 'keep'
        ? newSeed
          ? `keeping seed ${newSeed}`
          : 'seed could not be read — a new random seed will be used'
        : newSeed
          ? `with seed ${newSeed}`
          : 'with a new random seed';
    this.events.recordEvent({
      serverId,
      actor,
      type: 'world-reset',
      summary: `World "${level}" reset ${seedNote}${applyType ? `, type ${applyType}` : ''} (${this.archive.humanBytes(freedBytes)} cleared)`,
      details: {
        level,
        seedMode,
        seed: newSeed ? String(newSeed) : null,
        levelType: applyType || null,
        backup,
        freedBytes,
      },
    });
    this.indexer.scan().catch(() => {});
    return {
      level,
      seedMode,
      keptSeed: seedMode === 'keep' && newSeed ? String(newSeed) : null,
      seed: newSeed ? String(newSeed) : null,
      levelType: applyType || null,
      freedBytes,
    };
  }

  /** Delete a non-active world from a server. Returns freed bytes. */
  async deleteServerWorld(
    serverId: string,
    worldName: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<{ freedBytes: number }> {
    const server = await this.query.mustGet(serverId);
    this.archive.checkWorldName(worldName);
    if (worldName === this.props.activeLevelName(server)) {
      throw new ConflictException(
        'This is the active world — activate another world first, or use Reset to regenerate it',
      );
    }
    const dims = this.props.serverWorldDims(serverId, worldName);
    if (!fs.existsSync(dims[0] as string))
      throw new NotFoundException(
        `No world named "${worldName}" on this server`,
      );
    const freedBytes = await this.archive.dirsSize(dims);
    for (const dim of dims) await fsp.rm(dim, { recursive: true, force: true });
    this.events.recordEvent({
      serverId,
      actor,
      type: 'world-deleted',
      summary: `World "${worldName}" deleted (${this.archive.humanBytes(freedBytes)} freed)`,
      details: { worldName, freedBytes },
    });
    this.indexer.scan().catch(() => {});
    return { freedBytes };
  }
}
