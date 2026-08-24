import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import { ContainerService } from '../docker/container.service';
import { ServerQueryService } from '../servers/server-query.service';
import { ServerLifecycleService } from '../servers/server-lifecycle.service';
import { PathGuardService } from '../storage/path-guard.service';
import { StorageIndexService } from '../storage/storage-index.service';
import { EventsService } from '../events/events.service';
import type { Server } from '../servers/types';
import { WorldArchiveService, DIM_SUFFIXES } from './world-archive.service';
import { WorldPropsService } from './world-props.service';
import { WorldLibraryService } from './world-library.service';
import { WorldSaveLockService } from './world-save-lock.service';
import { BackupsService } from './backups.service';
import type { ServerWorldSummary } from '../../../shared/types/server-worlds';

export type { ServerWorldSummary };

const FLAVOR_LABEL: Record<string, string> = {
  VANILLA: 'Vanilla',
  PAPER: 'Paper',
  PURPUR: 'Purpur',
  PUFFERFISH: 'Pufferfish',
  FOLIA: 'Folia',
  LEAF: 'Leaf',
  SPIGOT: 'Spigot',
  BUKKIT: 'Bukkit',
  FABRIC: 'Fabric',
  FORGE: 'Forge',
  NEOFORGE: 'NeoForge',
  QUILT: 'Quilt',
  AUTO_CURSEFORGE: 'CurseForge pack',
  MODRINTH: 'Modrinth pack',
  FTBA: 'FTB pack',
  PACKWIZ: 'packwiz pack',
  CUSTOM: 'Custom jar',
};

// Server-type family — used for compat warnings (Bukkit-family splits worlds
// into three dirs; modded worlds carry loader-specific dimensions/data).
const FAMILY: Record<string, string> = {
  PAPER: 'bukkit',
  PURPUR: 'bukkit',
  SPIGOT: 'bukkit',
  BUKKIT: 'bukkit',
  FOLIA: 'bukkit',
  LEAF: 'bukkit',
  PUFFERFISH: 'bukkit',
  FABRIC: 'modded',
  FORGE: 'modded',
  NEOFORGE: 'modded',
  QUILT: 'modded',
  AUTO_CURSEFORGE: 'modded',
  MODRINTH: 'modded',
  FTBA: 'modded',
  PACKWIZ: 'modded',
};
const familyOf = (type: string): string => FAMILY[type] || 'vanilla';
const flavorLabel = (type: string): string => FLAVOR_LABEL[type] || type;

const LEVEL_TYPES = new Set(['DEFAULT', 'FLAT', 'LARGEBIOMES', 'AMPLIFIED']);

export interface CompatWorld {
  flavor?: string | null;
  version?: string | null;
}

export interface InstallToServerOptions {
  mode?: 'replace' | 'alongside';
  newName?: string;
  actor?: string;
}

export interface InstallToServerResult {
  installedAs: string;
  mode: 'replace' | 'alongside';
  warnings: string[];
  sizeBytes: number;
}

export interface CopyBetweenServersResult extends InstallToServerResult {
  library: { id: string };
}

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

export interface PreparedWorldDownload {
  absPath: string;
  filename: string;
  size: number;
}

/**
 * Per-server world operations: install/replace/alongside, copy between
 * instances, duplicate/rename/reset/delete, downloads, snapshot extraction.
 * Ports the "Extract from a server" / "Per-server world listing" /
 * "Install from library" / "Duplicate / rename / activate / reset / delete"
 * / "Downloads" sections of `src/services/worlds.ts`.
 */
@Injectable()
export class WorldOperationsService {
  constructor(
    private readonly query: ServerQueryService,
    private readonly lifecycle: ServerLifecycleService,
    private readonly containers: ContainerService,
    private readonly pathGuard: PathGuardService,
    private readonly indexer: StorageIndexService,
    private readonly events: EventsService,
    private readonly archive: WorldArchiveService,
    private readonly props: WorldPropsService,
    private readonly libraryWorldsService: WorldLibraryService,
    private readonly saveLock: WorldSaveLockService,
    private readonly backups: BackupsService,
  ) {}

  private async isRunning(serverId: string): Promise<boolean> {
    const info = await this.containers
      .inspectStatus(serverId)
      .catch(() => ({ exists: false, status: 'stopped' as const }));
    return (
      info.exists && ['running', 'starting', 'unhealthy'].includes(info.status)
    );
  }

  // Run the save-off/flush -> copy -> save-on dance under the shared
  // per-server save lock when running; when stopped, just run the copy directly.
  private async withPausedSaves<T>(
    serverId: string,
    running: boolean,
    copy: () => Promise<T>,
  ): Promise<T> {
    if (!running) return copy();
    return this.saveLock.withSaveLock(serverId, async () => {
      await this.containers
        .execCapture(serverId, ['rcon-cli', 'save-off'])
        .catch(() => {});
      await this.containers
        .execCapture(serverId, ['rcon-cli', 'save-all', 'flush'])
        .catch(() => {});
      await this.archive.sleep(2000);
      try {
        return await copy();
      } finally {
        await this.containers
          .execCapture(serverId, ['rcon-cli', 'save-on'])
          .catch(() => {});
      }
    });
  }

  compatWarnings(world: CompatWorld, server: Server): string[] {
    const warnings: string[] = [];
    if (world.flavor && familyOf(world.flavor) !== familyOf(server.type)) {
      warnings.push(
        `This world came from a ${flavorLabel(world.flavor)} server but the target runs ${flavorLabel(server.type)} — ` +
          'loader- or plugin-specific data (custom dimensions, plugin files) may not load.',
      );
    }
    const target = server.mc_version;
    if (
      world.version &&
      target &&
      target !== 'LATEST' &&
      target !== 'SNAPSHOT' &&
      world.version !== target
    ) {
      if (this.archive.compareVersions(world.version, target) > 0) {
        warnings.push(
          `The world was last played on Minecraft ${world.version} but this server runs ${target} — ` +
            'Minecraft cannot downgrade worlds safely; expect corruption or a refusal to load.',
        );
      } else {
        warnings.push(
          `Version differs: world ${world.version} → server ${target}. The world will be upgraded on first load and cannot be downgraded afterwards.`,
        );
      }
    }
    return warnings;
  }

  /**
   * Snapshot a server's active world (plus Bukkit-split dims) into the
   * library. Works while the server runs (save-off/save-all/save-on).
   */
  async extractFromServer(
    serverId: string,
    { name = '', actor = 'system' }: { name?: string; actor?: string } = {},
  ) {
    const server = await this.query.mustGet(serverId);
    const level = this.props.activeLevelName(server);
    const dims = this.props.serverWorldDims(serverId, level);
    if (!fs.existsSync(path.join(dims[0] as string, 'level.dat'))) {
      throw new NotFoundException(
        `World "${level}" has no level.dat yet — start the server once so it generates the world`,
      );
    }

    const worldBytes = await this.archive.dirsSize(dims);
    const { free } = await this.indexer.diskFree();
    if (free < worldBytes * 2.2) {
      throw new HttpException(
        `Not enough disk space to snapshot this world (~${this.archive.humanBytes(worldBytes * 2.2)} needed)`,
        507,
      );
    }

    const running = await this.isRunning(serverId);
    const tmpDir = this.pathGuard.dataPath('tmp', `world-snap-${nanoid(6)}`);
    const zipTmp = this.pathGuard.dataPath(
      'tmp',
      `world-snap-${nanoid(6)}.zip`,
    );
    await fsp.mkdir(tmpDir, { recursive: true });

    try {
      await this.withPausedSaves(serverId, running, async () => {
        for (const dim of dims) {
          await fsp.cp(dim, path.join(tmpDir, path.basename(dim)), {
            recursive: true,
          });
        }
      });

      const mainCopy = path.join(tmpDir, level);
      const dimCopies = dims
        .slice(1)
        .map((d) => path.join(tmpDir, path.basename(d)));
      await this.archive.zipWorld(zipTmp, mainCopy, dimCopies);

      const mcVersion =
        this.archive.readLevelVersion(path.join(mainCopy, 'level.dat')) ||
        (server.mc_version !== 'LATEST' && server.mc_version !== 'SNAPSHOT'
          ? server.mc_version
          : null);

      const row = await this.libraryWorldsService.addZipToLibrary(zipTmp, {
        name: (name || '').trim() || `${server.display_name} — ${level}`,
        actor,
        worldSource: `extract:${serverId}`,
        worldFlavor: server.type,
        mcVersion,
        split: dims.length > 1,
      });
      this.events.recordEvent({
        serverId,
        actor,
        type: 'world-extracted',
        summary: `World "${level}" saved to library as "${row.name}" (${this.archive.humanBytes(Number(row.sizeBytes))})`,
        details: {
          libraryId: row.id,
          level,
          sizeBytes: row.sizeBytes,
          running,
        },
      });
      return row;
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(zipTmp, { force: true }).catch(() => {});
    }
  }

  /**
   * Scan a server dir for worlds (top-level dirs containing level.dat),
   * grouping Bukkit-split dims under their main world and marking the active one.
   */
  async listServerWorlds(serverId: string): Promise<ServerWorldSummary[]> {
    const server = await this.query.mustGet(serverId);
    const base = this.pathGuard.dataPath('servers', serverId);
    const level = this.props.activeLevelName(server);
    const props = this.props.readProps(serverId);

    let entries;
    try {
      entries = await fsp.readdir(base, { withFileTypes: true });
    } catch {
      return [];
    }
    const dirNames = new Set<string>(
      entries.filter((e) => e.isDirectory()).map((e) => e.name),
    );
    const withLevelDat: string[] = [...dirNames].filter((n) =>
      fs.existsSync(path.join(base, n, 'level.dat')),
    );

    const mains = withLevelDat.filter((n) => {
      const m = this.archive.dimBase(n);
      return !(m && dirNames.has(m) && withLevelDat.includes(m));
    });

    const worlds: ServerWorldSummary[] = [];
    for (const main of mains) {
      const dimNames = [
        main,
        ...DIM_SUFFIXES.map((s) => main + s).filter((d) => dirNames.has(d)),
      ];
      const sizeBytes = await this.archive.dirsSize(
        dimNames.map((d) => path.join(base, d)),
      );
      const active = main === level;
      worlds.push({
        name: main,
        active,
        dims: dimNames,
        sizeBytes,
        seed: active ? props.get('level-seed') || null : null,
      });
    }
    worlds.sort(
      (a, b) =>
        Number(b.active) - Number(a.active) || a.name.localeCompare(b.name),
    );
    return worlds;
  }

  /** Compat warnings for installing library world `libraryId` into `serverId`. */
  async installWarnings(
    libraryId: string,
    serverId: string,
  ): Promise<string[]> {
    const lib = await this.libraryWorldsService.mustLibWorld(libraryId);
    const server = await this.query.mustGet(serverId);
    return this.compatWarnings(
      { flavor: lib.worldFlavor, version: lib.version },
      server,
    );
  }

  /**
   * Install a library world into a server.
   * mode 'replace': requires the server stopped; safety backup, then the
   *                 active world dirs are replaced in place (level-name unchanged).
   * mode 'alongside': extracts under `newName` next to existing worlds —
   *                   switch with activateWorld later. Safe while running.
   */
  async installToServer(
    libraryId: string,
    serverId: string,
    {
      mode = 'replace',
      newName = '',
      actor = 'system',
    }: InstallToServerOptions = {},
  ): Promise<InstallToServerResult> {
    const lib = await this.libraryWorldsService.mustLibWorld(libraryId);
    const server = await this.query.mustGet(serverId);
    const warnings = this.compatWarnings(
      { flavor: lib.worldFlavor, version: lib.version },
      server,
    );

    const libSizeBytes = lib.sizeBytes;
    await this.indexer.assertUnderQuota(
      {
        id: server.id,
        display_name: server.display_name,
        disk_quota_bytes: server.disk_quota_bytes,
      },
      libSizeBytes * 2,
    );
    const { free } = await this.indexer.diskFree();
    if (free < libSizeBytes * 2.5) {
      throw new HttpException(
        `Not enough disk space to install this world (~${this.archive.humanBytes(libSizeBytes * 2.5)} needed)`,
        507,
      );
    }

    let targetLevel: string;
    if (mode === 'replace') {
      if (await this.isRunning(serverId)) {
        throw new ConflictException(
          'Stop the server before replacing its active world — swapping it while running would corrupt the save',
        );
      }
      targetLevel = this.props.activeLevelName(server);
      await this.backups.createBackup(serverId, {
        reason: 'manual',
        actor,
        note: `Safety backup before installing world "${lib.name}"`,
      });
    } else {
      targetLevel = this.archive.sanitizeWorldName(newName || lib.name);
      if (
        fs.existsSync(this.pathGuard.dataPath('servers', serverId, targetLevel))
      ) {
        throw new ConflictException(
          `A world named "${targetLevel}" already exists on this server — pick another name`,
        );
      }
    }

    const tmpDir = this.pathGuard.dataPath('tmp', `world-install-${nanoid(6)}`);
    await fsp.mkdir(tmpDir, { recursive: true });
    let replacedBytes = 0;
    try {
      await this.archive.extractZip(
        this.pathGuard.dataPath(lib.relPath),
        tmpDir,
      );

      const tops = await fsp.readdir(tmpDir, { withFileTypes: true });
      const dimTops = tops.filter(
        (e) => e.isDirectory() && this.archive.isDimName(e.name),
      );
      const mainTops = tops.filter((e) => !dimTops.includes(e));

      if (mode === 'replace') {
        for (const dim of this.props.serverWorldDims(serverId, targetLevel)) {
          replacedBytes += await this.archive.dirsSize([dim]);
          await fsp.rm(dim, { recursive: true, force: true });
        }
      }

      const mainDir = this.pathGuard.dataPath('servers', serverId, targetLevel);
      await fsp.mkdir(mainDir, { recursive: true });
      for (const e of mainTops) {
        await this.archive.moveEntry(
          path.join(tmpDir, e.name),
          path.join(mainDir, e.name),
        );
      }
      for (const e of dimTops) {
        const suffix = e.name.endsWith('_the_end') ? '_the_end' : '_nether';
        await this.archive.moveEntry(
          path.join(tmpDir, e.name),
          this.pathGuard.dataPath('servers', serverId, targetLevel + suffix),
        );
      }
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }

    const sizeBytes = await this.archive.dirsSize(
      this.props.serverWorldDims(serverId, targetLevel),
    );
    this.events.recordEvent({
      serverId,
      actor,
      type: 'world-installed',
      summary: `World "${lib.name}" installed as "${targetLevel}" (${mode}, ${this.archive.humanBytes(sizeBytes)})`,
      details: {
        libraryId,
        mode,
        installedAs: targetLevel,
        sizeBytes,
        replacedBytes,
        warnings,
      },
    });
    this.indexer.scan().catch(() => {});
    return { installedAs: targetLevel, mode, warnings, sizeBytes };
  }

  /** Warnings for a server->server copy (source world flavor/version vs target). */
  async copyWarnings(
    sourceServerId: string,
    targetServerId: string,
  ): Promise<string[]> {
    const source = await this.query.mustGet(sourceServerId);
    const target = await this.query.mustGet(targetServerId);
    const level = this.props.activeLevelName(source);
    const version =
      this.archive.readLevelVersion(
        this.pathGuard.dataPath('servers', sourceServerId, level, 'level.dat'),
      ) ||
      (source.mc_version !== 'LATEST' && source.mc_version !== 'SNAPSHOT'
        ? source.mc_version
        : null);
    return this.compatWarnings({ flavor: source.type, version }, target);
  }

  /**
   * Copy the active world from one server to another via the library
   * machinery: snapshot source (works while running) -> install into target.
   */
  async copyBetweenServers(
    sourceServerId: string,
    targetServerId: string,
    {
      mode = 'replace',
      newName = '',
      actor = 'system',
    }: InstallToServerOptions = {},
  ): Promise<CopyBetweenServersResult> {
    const source = await this.query.mustGet(sourceServerId);
    const target = await this.query.mustGet(targetServerId);
    if (sourceServerId === targetServerId)
      throw new BadRequestException(
        'Source and target are the same server — use Duplicate instead',
      );

    const row = await this.extractFromServer(sourceServerId, {
      name: `${source.display_name} → ${target.display_name} (copy)`,
      actor,
    });
    const result = await this.installToServer(row.id, targetServerId, {
      mode,
      newName,
      actor,
    });
    this.events.recordEvent({
      serverId: targetServerId,
      actor,
      type: 'world-copied',
      summary: `World copied from ${source.display_name} (${this.archive.humanBytes(result.sizeBytes)}, ${mode})`,
      details: { sourceServerId, libraryId: row.id, ...result },
    });
    return { library: { id: row.id }, ...result };
  }

  /** Fork a copy of a world within the same server (consistent while running). */
  async duplicateWorld(
    serverId: string,
    worldName: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<{ name: string; sizeBytes: number }> {
    const server = await this.query.mustGet(serverId);
    this.archive.checkWorldName(worldName);
    const dims = this.props.serverWorldDims(serverId, worldName);
    if (!fs.existsSync(dims[0] as string))
      throw new NotFoundException(
        `No world named "${worldName}" on this server`,
      );

    let copyName = `${worldName}-copy`;
    for (
      let i = 2;
      fs.existsSync(this.pathGuard.dataPath('servers', serverId, copyName));
      i++
    )
      copyName = `${worldName}-copy${i}`;

    const sizeBytes = await this.archive.dirsSize(dims);
    await this.indexer.assertUnderQuota(
      {
        id: server.id,
        display_name: server.display_name,
        disk_quota_bytes: server.disk_quota_bytes,
      },
      sizeBytes,
    );
    const { free } = await this.indexer.diskFree();
    if (free < sizeBytes * 1.1)
      throw new HttpException(
        `Not enough disk space to duplicate (~${this.archive.humanBytes(sizeBytes)} needed)`,
        507,
      );

    const active = worldName === this.props.activeLevelName(server);
    const running = active && (await this.isRunning(serverId));
    await this.withPausedSaves(serverId, running, async () => {
      for (const dim of dims) {
        const suffix = path.basename(dim).slice(worldName.length);
        await fsp.cp(
          dim,
          this.pathGuard.dataPath('servers', serverId, copyName + suffix),
          { recursive: true },
        );
      }
    });

    this.events.recordEvent({
      serverId,
      actor,
      type: 'world-duplicated',
      summary: `World "${worldName}" duplicated as "${copyName}" (${this.archive.humanBytes(sizeBytes)})`,
      details: { worldName, copyName, sizeBytes },
    });
    this.indexer.scan().catch(() => {});
    return { name: copyName, sizeBytes };
  }

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
    if (await this.isRunning(serverId))
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
    if (await this.isRunning(serverId))
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
    if (await this.isRunning(serverId))
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

  /**
   * Zip a server world for a one-off download (consistent snapshot while
   * running). Caller must delete absPath when done sending.
   */
  async prepareWorldDownload(
    serverId: string,
    worldName: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<PreparedWorldDownload> {
    const server = await this.query.mustGet(serverId);
    this.archive.checkWorldName(worldName);
    const dims = this.props.serverWorldDims(serverId, worldName);
    if (!fs.existsSync(dims[0] as string))
      throw new NotFoundException(
        `No world named "${worldName}" on this server`,
      );

    const sizeBytes = await this.archive.dirsSize(dims);
    const { free } = await this.indexer.diskFree();
    if (free < sizeBytes * 1.2)
      throw new HttpException(
        `Not enough disk space to stage the download (~${this.archive.humanBytes(sizeBytes)} needed)`,
        507,
      );

    const active = worldName === this.props.activeLevelName(server);
    const running = active && (await this.isRunning(serverId));
    const zipAbs = this.pathGuard.dataPath('tmp', `world-dl-${nanoid(6)}.zip`);
    await this.withPausedSaves(serverId, running, async () => {
      await this.archive.zipWorld(zipAbs, dims[0] as string, dims.slice(1));
    });
    const size = (await fsp.stat(zipAbs)).size;
    this.events.recordEvent({
      serverId,
      actor,
      type: 'world-downloaded',
      summary: `World "${worldName}" downloaded (${this.archive.humanBytes(size)})`,
      details: { worldName, sizeBytes: size },
    });
    return {
      absPath: zipAbs,
      filename: `${this.archive.sanitizeFilename(server.display_name)}-${this.archive.sanitizeFilename(worldName)}.zip`,
      size,
    };
  }
}
