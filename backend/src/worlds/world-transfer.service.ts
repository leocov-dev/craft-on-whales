import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import { ServerQueryService } from '../servers/server-query.service';
import { PathGuardService } from '../storage/path-guard.service';
import { StorageIndexService } from '../storage/storage-index.service';
import { EventsService } from '../events/events.service';
import type { Server } from '../servers/types';
import { WorldArchiveService } from './world-archive.service';
import { WorldPropsService } from './world-props.service';
import { WorldLibraryService } from './world-library.service';
import { BackupsService } from './backups.service';
import { WorldRuntimeService } from './world-runtime.service';

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
// No canonical server-flavor registry exists anywhere in the codebase to
// derive these from — servers/, mods/ (PLUGIN_TYPES), and the frontend
// wizard each keep their own independent grouping for their own purpose, so
// there's nothing single-source-of-truth to point at here. Instead: warn
// once per unrecognized type so a flavor missing from these maps surfaces in
// the logs instead of silently falling back to the wrong label/family.
const unknownFlavorLogger = new Logger('WorldTransferService:flavorMaps');
const warnedUnknownFlavors = new Set<string>();
function warnUnknownFlavorOnce(type: string): void {
  if (warnedUnknownFlavors.has(type)) return;
  warnedUnknownFlavors.add(type);
  unknownFlavorLogger.warn(
    `server type "${type}" is missing from FLAVOR_LABEL/FAMILY — compat warnings for it will use a generic fallback`,
  );
}
// FLAVOR_LABEL lists every flavor this module knows about, including ones
// that intentionally default to the 'vanilla' family (VANILLA, CUSTOM) —
// so it's the right membership check for "is this type known at all",
// even from familyOf().
const familyOf = (type: string): string => {
  if (!(type in FLAVOR_LABEL)) warnUnknownFlavorOnce(type);
  return FAMILY[type] || 'vanilla';
};
const flavorLabel = (type: string): string => {
  if (!(type in FLAVOR_LABEL)) warnUnknownFlavorOnce(type);
  return FLAVOR_LABEL[type] || type;
};

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

export interface PreparedWorldDownload {
  absPath: string;
  filename: string;
  size: number;
}

/**
 * World-data transfer workflows: snapshotting a live world into the
 * library, installing a library world onto a server, copying a world
 * between servers, forking a same-server duplicate, and staging a one-off
 * download zip. Grouped together because they all move/copy whole world
 * directory trees through the same disk-quota / free-space / zip-archive
 * machinery, and share `WorldRuntimeService`'s save-pause dance.
 */
@Injectable()
export class WorldTransferService {
  constructor(
    private readonly query: ServerQueryService,
    private readonly pathGuard: PathGuardService,
    private readonly indexer: StorageIndexService,
    private readonly events: EventsService,
    private readonly archive: WorldArchiveService,
    private readonly props: WorldPropsService,
    private readonly libraryWorldsService: WorldLibraryService,
    private readonly backups: BackupsService,
    private readonly runtime: WorldRuntimeService,
  ) {}

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

    const running = await this.runtime.isRunning(serverId);
    const tmpDir = this.pathGuard.dataPath('tmp', `world-snap-${nanoid(6)}`);
    const zipTmp = this.pathGuard.dataPath(
      'tmp',
      `world-snap-${nanoid(6)}.zip`,
    );
    await fsp.mkdir(tmpDir, { recursive: true });

    try {
      await this.runtime.withPausedSaves(serverId, running, async () => {
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
      if (await this.runtime.isRunning(serverId)) {
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
        // dimTops was filtered via isDimName(), so dimBase() is guaranteed
        // non-null here; deriving the suffix from it (rather than a
        // hardcoded _the_end/_nether ternary) means a third DIM_SUFFIXES
        // entry is honored automatically.
        const base = this.archive.dimBase(e.name)!;
        const suffix = e.name.slice(base.length);
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
    const running = active && (await this.runtime.isRunning(serverId));
    await this.runtime.withPausedSaves(serverId, running, async () => {
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
    const running = active && (await this.runtime.isRunning(serverId));
    const zipAbs = this.pathGuard.dataPath('tmp', `world-dl-${nanoid(6)}.zip`);
    await this.runtime.withPausedSaves(serverId, running, async () => {
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
