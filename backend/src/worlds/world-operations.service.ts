import { Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ServerQueryService } from '../servers/server-query.service';
import { PathGuardService } from '../storage/path-guard.service';
import type { Server } from '../servers/types';
import { WorldArchiveService, DIM_SUFFIXES } from './world-archive.service';
import { WorldPropsService } from './world-props.service';
import { WorldTransferService } from './world-transfer.service';
import { WorldLifecycleService } from './world-lifecycle.service';
import type {
  CompatWorld,
  InstallToServerOptions,
  InstallToServerResult,
  CopyBetweenServersResult,
  PreparedWorldDownload,
} from './world-transfer.service';
import type {
  ResetWorldOptions,
  ResetWorldResult,
} from './world-lifecycle.service';
import type { ServerWorldSummary } from '../../../shared/types/server-worlds';

export type { ServerWorldSummary };
export type {
  CompatWorld,
  InstallToServerOptions,
  InstallToServerResult,
  CopyBetweenServersResult,
  PreparedWorldDownload,
  ResetWorldOptions,
  ResetWorldResult,
};

/**
 * Per-server world operations facade: the controller's single entry point
 * for install/replace/alongside, copy between instances, duplicate/rename/
 * activate/reset/delete, downloads, and snapshot extraction.
 *
 * Ports the "Extract from a server" / "Per-server world listing" /
 * "Install from library" / "Duplicate / rename / activate / reset / delete"
 * / "Downloads" sections of `src/services/worlds.ts`.
 *
 * The nine write workflows live in two collaborators split along how they
 * touch disk: `WorldTransferService` (extract/install/copy/duplicate/
 * download-prep — all move or copy whole world trees through the
 * library/quota/zip machinery) and `WorldLifecycleService` (rename/
 * activate/reset/delete — in-place changes to an already-installed world,
 * no library or zipping involved). This class keeps only the one read-only
 * workflow (`listServerWorlds`) that doesn't belong to either, plus thin
 * delegation so the controller's call surface is unchanged.
 */
@Injectable()
export class WorldOperationsService {
  constructor(
    private readonly query: ServerQueryService,
    private readonly pathGuard: PathGuardService,
    private readonly archive: WorldArchiveService,
    private readonly props: WorldPropsService,
    private readonly transfer: WorldTransferService,
    private readonly lifecycleOps: WorldLifecycleService,
  ) {}

  compatWarnings(world: CompatWorld, server: Server): string[] {
    return this.transfer.compatWarnings(world, server);
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

  // -- transfer workflows: delegate to WorldTransferService -----------------

  async extractFromServer(
    serverId: string,
    opts: { name?: string; actor?: string } = {},
  ) {
    return this.transfer.extractFromServer(serverId, opts);
  }

  async installWarnings(
    libraryId: string,
    serverId: string,
  ): Promise<string[]> {
    return this.transfer.installWarnings(libraryId, serverId);
  }

  async installToServer(
    libraryId: string,
    serverId: string,
    opts: InstallToServerOptions = {},
  ): Promise<InstallToServerResult> {
    return this.transfer.installToServer(libraryId, serverId, opts);
  }

  async copyWarnings(
    sourceServerId: string,
    targetServerId: string,
  ): Promise<string[]> {
    return this.transfer.copyWarnings(sourceServerId, targetServerId);
  }

  async copyBetweenServers(
    sourceServerId: string,
    targetServerId: string,
    opts: InstallToServerOptions = {},
  ): Promise<CopyBetweenServersResult> {
    return this.transfer.copyBetweenServers(
      sourceServerId,
      targetServerId,
      opts,
    );
  }

  async duplicateWorld(
    serverId: string,
    worldName: string,
    opts: { actor?: string } = {},
  ): Promise<{ name: string; sizeBytes: number }> {
    return this.transfer.duplicateWorld(serverId, worldName, opts);
  }

  async prepareWorldDownload(
    serverId: string,
    worldName: string,
    opts: { actor?: string } = {},
  ): Promise<PreparedWorldDownload> {
    return this.transfer.prepareWorldDownload(serverId, worldName, opts);
  }

  // -- lifecycle workflows: delegate to WorldLifecycleService ---------------

  async renameWorld(
    serverId: string,
    worldName: string,
    newName: string,
    opts: { actor?: string } = {},
  ): Promise<{ name: string; wasActive: boolean }> {
    return this.lifecycleOps.renameWorld(serverId, worldName, newName, opts);
  }

  async activateWorld(
    serverId: string,
    worldName: string,
    opts: { actor?: string } = {},
  ): Promise<{ active: string; changed: boolean }> {
    return this.lifecycleOps.activateWorld(serverId, worldName, opts);
  }

  async resetWorld(
    serverId: string,
    opts: ResetWorldOptions = {},
  ): Promise<ResetWorldResult> {
    return this.lifecycleOps.resetWorld(serverId, opts);
  }

  async deleteServerWorld(
    serverId: string,
    worldName: string,
    opts: { actor?: string } = {},
  ): Promise<{ freedBytes: number }> {
    return this.lifecycleOps.deleteServerWorld(serverId, worldName, opts);
  }
}
