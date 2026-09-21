import { Inject, Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import { PathGuardService } from '../storage/path-guard.service';
import { ServerLifecycleService } from '../servers/server-lifecycle.service';
import { ServerPropertiesService } from '../servers/server-properties.service';
import type { Server } from '../servers/types';
import { DIM_SUFFIXES } from './world-archive.service';
import {
  MAP_SERVICE_CONTRACT,
  type MapServiceContract,
} from './map-service.contract';

/**
 * Active-level and per-world-directory bookkeeping. The server.properties
 * file itself belongs to `ServerPropertiesService`, which also owns the env
 * unlock that keeps an edit from being reverted on the next container start;
 * the two helpers here just forward to it so world-side callers don't need
 * both injected.
 */
@Injectable()
export class WorldPropsService {
  constructor(
    private readonly pathGuard: PathGuardService,
    private readonly lifecycle: ServerLifecycleService,
    private readonly properties: ServerPropertiesService,
    @Inject(MAP_SERVICE_CONTRACT)
    private readonly map: MapServiceContract,
  ) {}

  /** Active level name: LEVEL env wins, then server.properties, then 'world'. */
  activeLevelName(server: Server): string {
    return (
      (server.env && server.env.LEVEL) ||
      this.readProps(server.id).get('level-name') ||
      'world'
    );
  }

  /** Parse server.properties into a Map (empty when missing). */
  readProps(serverId: string): Map<string, string> {
    return this.properties.read(serverId);
  }

  /**
   * Set one server.properties key without unlocking its env var. Only for
   * callers that set the property and its env var together (see
   * `setActiveLevel` and the world reset's SEED/LEVEL_TYPE handling) — every
   * other edit must go through `ServerPropertiesService.setProperty()` so the
   * image stops overwriting the key on each start.
   */
  setProp(serverId: string, key: string, value: string): void {
    this.properties.write(serverId, { [key]: value });
  }

  /** Point the server at a new level: property always, LEVEL env when present. */
  async setActiveLevel(
    server: Server,
    levelName: string,
    { actor }: { actor?: string },
  ): Promise<void> {
    this.setProp(server.id, 'level-name', levelName);
    if (server.env && server.env.LEVEL !== undefined) {
      await this.lifecycle.updateServer(
        server.id,
        { env: { ...server.env, LEVEL: levelName } },
        { actor },
      );
    }
    await this.map.writeMapConfigs(server.id);
  }

  /** Existing dim dirs for a world: [main, main_nether?, main_the_end?] (absolute). */
  serverWorldDims(serverId: string, worldName: string): string[] {
    const main = this.pathGuard.dataPath('servers', serverId, worldName);
    const dims = [main];
    for (const suffix of DIM_SUFFIXES) {
      const sibling = this.pathGuard.dataPath(
        'servers',
        serverId,
        worldName + suffix,
      );
      if (fs.existsSync(sibling)) dims.push(sibling);
    }
    return dims;
  }
}
