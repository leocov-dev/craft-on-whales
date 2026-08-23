import { forwardRef, Inject, Injectable } from '@nestjs/common';
import * as fs from 'node:fs';
import { PathGuardService } from '../storage/path-guard.service';
import { ServerLifecycleService } from '../servers/server-lifecycle.service';
import type { Server } from '../servers/types';
import { DIM_SUFFIXES } from './world-archive.service';
// `import type` — see MapService's own doc comment on the
// ServersModule<->MapModule<->WorldsModule cycle for why this must be a
// lazy require() at the @Inject site, not a plain import.
import type { MapService } from '../map/map.service';

/**
 * server.properties + active-level bookkeeping. Ports the "server.properties
 * + level helpers" section of `src/services/worlds.ts`.
 */
@Injectable()
export class WorldPropsService {
  constructor(
    private readonly pathGuard: PathGuardService,
    private readonly lifecycle: ServerLifecycleService,
    @Inject(forwardRef(() => require('../map/map.service').MapService))
    private readonly map: MapService
  ) {}

  /** Active level name: LEVEL env wins, then server.properties, then 'world'. */
  activeLevelName(server: Server): string {
    return (server.env && server.env.LEVEL) || this.readProps(server.id).get('level-name') || 'world';
  }

  /** Parse server.properties into a Map (empty when missing). */
  readProps(serverId: string): Map<string, string> {
    const map = new Map<string, string>();
    try {
      const text: string = fs.readFileSync(this.pathGuard.dataPath('servers', serverId, 'server.properties'), 'utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq > 0) map.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
      }
    } catch {
      /* fresh server */
    }
    return map;
  }

  /** Set one server.properties key atomically (create the file when missing). */
  setProp(serverId: string, key: string, value: string): void {
    const file = this.pathGuard.dataPath('servers', serverId, 'server.properties');
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      /* create fresh */
    }
    const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=.*$`, 'm');
    if (re.test(text)) text = text.replace(re, `${key}=${value}`);
    else text += `${text && !text.endsWith('\n') ? '\n' : ''}${key}=${value}\n`;
    const tmp = this.pathGuard.dataPath('servers', serverId, 'server.properties.tmp');
    fs.mkdirSync(this.pathGuard.dataPath('servers', serverId), { recursive: true });
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }

  /** Point the server at a new level: property always, LEVEL env when present. */
  setActiveLevel(server: Server, levelName: string, { actor }: { actor?: string }): void {
    this.setProp(server.id, 'level-name', levelName);
    if (server.env && server.env.LEVEL !== undefined) {
      this.lifecycle.updateServer(server.id, { env: { ...server.env, LEVEL: levelName } }, { actor });
    }
    this.map.writeMapConfigs(server.id);
  }

  /** Existing dim dirs for a world: [main, main_nether?, main_the_end?] (absolute). */
  serverWorldDims(serverId: string, worldName: string): string[] {
    const main = this.pathGuard.dataPath('servers', serverId, worldName);
    const dims = [main];
    for (const suffix of DIM_SUFFIXES) {
      const sibling = this.pathGuard.dataPath('servers', serverId, worldName + suffix);
      if (fs.existsSync(sibling)) dims.push(sibling);
    }
    return dims;
  }
}
