import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import { eq, and } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { integrations, servers, serverContent } from '../db/schema';
import { EventsService } from '../events/events.service';
import { PathGuardService } from '../storage/path-guard.service';
import { ModsService } from '../mods/mods.service';
import type { MapConfig, EnableMapResult } from './map.types';
import type { Server } from '../servers/types';

// `import type` (not a normal import) for both ServerQueryService and
// WorldPropsService — a plain import here would join the synchronous
// require() cycle MapModule<->ServersModule<->WorldsModule creates at the
// file level (same hazard documented at length in
// server-lifecycle.service.ts's ServersModule<->SchedulerModule comment).
// The runtime class references for @Inject/forwardRef below come from a
// lazy require() instead, resolved only once Nest's post-bootstrap DI phase
// runs, by which point every module has finished loading.
import type { ServerQueryService } from '../servers/server-query.service';
import type { WorldPropsService } from '../worlds/world-props.service';

export const BLUEMAP_CONTAINER_PORT = '8100/tcp';
const HOST_PORT_START = 8123;

const SUPPORTED = new Set([
  'FABRIC',
  'QUILT',
  'FORGE',
  'NEOFORGE',
  'PAPER',
  'PURPUR',
  'PUFFERFISH',
  'LEAF',
  'FOLIA',
  'SPIGOT',
]);

const PLUGIN_TYPES = new Set([
  'PAPER',
  'PURPUR',
  'PUFFERFISH',
  'LEAF',
  'FOLIA',
  'SPIGOT',
]);

const DIM_CONFIGS = [
  {
    suffix: '',
    file: 'world.conf',
    dimension: 'minecraft:overworld',
    name: 'Overworld',
  },
  {
    suffix: '_nether',
    file: 'world_nether.conf',
    dimension: 'minecraft:the_nether',
    name: 'Nether',
  },
  {
    suffix: '_the_end',
    file: 'world_the_end.conf',
    dimension: 'minecraft:the_end',
    name: 'End',
  },
];

/**
 * Live world map (MP1): one-click BlueMap install via the mod-overlay
 * pipeline, with the map web server exposed on a panel-allocated host port.
 * Ports `src/services/map.ts`. Resolves both `TODO(MapModule)` markers left
 * in `ServerEnvironmentService.mergeExtraPorts` and
 * `WorldPropsService.setActiveLevel` — both now call this service for real.
 */
@Injectable()
export class MapService {
  constructor(
    private readonly dbService: DbService,
    private readonly events: EventsService,
    private readonly pathGuard: PathGuardService,
    private readonly mods: ModsService,
    @Inject(
      forwardRef(
        () => require('../servers/server-query.service').ServerQueryService,
      ),
    )
    private readonly serverQuery: ServerQueryService,
    @Inject(
      forwardRef(
        () => require('../worlds/world-props.service').WorldPropsService,
      ),
    )
    private readonly worldProps: WorldPropsService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  async getMapConfig(serverId: string): Promise<MapConfig> {
    const [row] = await this.db
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.serverId, serverId),
          eq(integrations.kind, 'bluemap'),
        ),
      )
      .limit(1);
    if (!row) return { enabled: false, hostPort: null };
    const cfg = JSON.parse(row.configJson || '{}') as { hostPort?: number };
    return { enabled: Boolean(row.enabled), hostPort: cfg.hostPort || null };
  }

  supportsMap(server: Server): boolean {
    return (
      SUPPORTED.has(server.type) ||
      (this.mods.isPackServer(server) && Boolean(this.mods.loaderOf(server)))
    );
  }

  /** Plugin servers read plugins/BlueMap/, mod servers config/bluemap/. */
  private mapConfDir(serverId: string, server: Server): string {
    const rel = PLUGIN_TYPES.has(server.type)
      ? ['plugins', 'BlueMap']
      : ['config', 'bluemap'];
    return this.pathGuard.dataPath('servers', serverId, ...rel);
  }

  /**
   * Point BlueMap's per-dimension map configs at the server's ACTUAL world
   * folder (server.properties level-name / LEVEL env) instead of BlueMap's
   * own "world" / "world_nether" / "world_the_end" default guess. A server
   * whose active world isn't literally named "world" otherwise makes every
   * auto-generated map invalid — BlueMap logs "problem with your BlueMap
   * setup" for each one and disables itself entirely, even though the world
   * exists and is fine.
   *
   * Only ever touches the `world:` line — a file BlueMap (or the admin)
   * already created keeps every other setting (name, sky-color, start-pos,
   * …) as-is.
   */
  async writeMapConfigs(serverId: string): Promise<void> {
    const server = await this.serverQuery.getServer(serverId);
    if (!server) return;
    const level = this.worldProps.activeLevelName(server);
    const mapsDir = path.join(this.mapConfDir(serverId, server), 'maps');
    fs.mkdirSync(mapsDir, { recursive: true });

    for (const dim of DIM_CONFIGS) {
      const worldFolder = level + dim.suffix;
      // Nether/end aren't generated until first visited — skip rather than
      // point BlueMap at a dir that doesn't exist yet (same failure this fixes).
      if (
        dim.suffix &&
        !fs.existsSync(
          this.pathGuard.dataPath('servers', serverId, worldFolder),
        )
      )
        continue;

      const file = path.join(mapsDir, dim.file);
      const worldLine = `world: "${worldFolder}"`;
      if (!fs.existsSync(file)) {
        fs.writeFileSync(
          file,
          `${worldLine}\ndimension: "${dim.dimension}"\nname: "${dim.name}"\n`,
        );
        continue;
      }
      const text = fs.readFileSync(file, 'utf8');
      const escaped = worldFolder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`^world\\s*:\\s*"?${escaped}"?\\s*$`, 'm').test(text))
        continue; // already correct
      const patched = /^world\s*:.*$/m.test(text)
        ? text.replace(/^world\s*:.*$/m, worldLine)
        : `${worldLine}\n${text}`;
      fs.writeFileSync(file, patched);
    }
  }

  async enableMap(
    serverId: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<EnableMapResult> {
    const server = await this.serverQuery.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');
    if (!this.supportsMap(server)) {
      throw new BadRequestException(
        `Live map needs a mod loader or plugin server — ${server.type} isn't supported by BlueMap`,
      );
    }

    const hostPort = await this.freePort();
    // BlueMap from Modrinth: the mods service resolves the right build for
    // this server's loader + MC version and installs it as an overlay entry.
    await this.mods.installFromUrl(
      serverId,
      'https://modrinth.com/plugin/bluemap',
      { actor },
    );

    await this.db
      .insert(integrations)
      .values({
        serverId,
        kind: 'bluemap',
        enabled: true,
        configJson: JSON.stringify({ hostPort }),
      })
      .onConflictDoUpdate({
        target: [integrations.serverId, integrations.kind],
        set: { enabled: true, configJson: JSON.stringify({ hostPort }) },
      });

    // Pre-accept BlueMap's resource download so the map works without a
    // manual config edit (BlueMap merges missing keys with its defaults).
    const confDir = this.mapConfDir(serverId, server);
    fs.mkdirSync(confDir, { recursive: true });
    const coreConf = path.join(confDir, 'core.conf');
    if (!fs.existsSync(coreConf)) {
      fs.writeFileSync(coreConf, 'accept-download: true\n');
    } else if (
      !/accept-download\s*:\s*true/.test(fs.readFileSync(coreConf, 'utf8'))
    ) {
      fs.writeFileSync(
        coreConf,
        fs
          .readFileSync(coreConf, 'utf8')
          .replace(/accept-download\s*:\s*false/, 'accept-download: true'),
      );
    }
    await this.writeMapConfigs(serverId);
    await this.db
      .update(servers)
      .set({ pendingRecreate: true })
      .where(eq(servers.id, serverId));
    this.events.recordEvent({
      serverId,
      actor,
      type: 'map-enabled',
      summary: `Live map enabled (BlueMap on port ${hostPort}) — applies on next restart`,
    });
    return { hostPort };
  }

  async disableMap(
    serverId: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<void> {
    const server = await this.serverQuery.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');
    await this.db
      .update(integrations)
      .set({ enabled: false })
      .where(
        and(
          eq(integrations.serverId, serverId),
          eq(integrations.kind, 'bluemap'),
        ),
      );
    // Remove the BlueMap jar (overlay row) if present.
    const overlayRows = await this.db
      .select({ filename: serverContent.filename })
      .from(serverContent)
      .where(
        and(
          eq(serverContent.serverId, serverId),
          eq(serverContent.managedBy, 'overlay'),
        ),
      );
    const row = overlayRows.find((r) => r.filename.startsWith('BlueMap'));
    if (row)
      await this.mods
        .removeContent(serverId, row.filename, { actor })
        .catch(() => undefined);
    await this.db
      .update(servers)
      .set({ pendingRecreate: true })
      .where(eq(servers.id, serverId));
    this.events.recordEvent({
      serverId,
      actor,
      type: 'map-disabled',
      summary: 'Live map disabled — applies on next restart',
    });
  }

  /** Extra container ports for a server, consumed by the servers service. */
  async extraPortsFor(
    serverId: string,
  ): Promise<{ container: string; host: number }[]> {
    const cfg = await this.getMapConfig(serverId);
    return cfg.enabled && cfg.hostPort
      ? [{ container: BLUEMAP_CONTAINER_PORT, host: cfg.hostPort }]
      : [];
  }

  private async freePort(): Promise<number> {
    const rows = await this.db
      .select({ configJson: integrations.configJson })
      .from(integrations)
      .where(eq(integrations.kind, 'bluemap'));
    const used = new Set(
      rows.map(
        (r) =>
          (JSON.parse(r.configJson || '{}') as { hostPort?: number }).hostPort,
      ),
    );
    for (let port = HOST_PORT_START; port < HOST_PORT_START + 500; port += 1) {
      if (used.has(port)) continue;
      const free = await new Promise<boolean>((resolve) => {
        const srv = net.createServer();
        srv.unref();
        srv.once('error', () => resolve(false));
        srv.listen({ port, host: '0.0.0.0', exclusive: true }, () =>
          srv.close(() => resolve(true)),
        );
      });
      if (free) return port;
    }
    throw new ServiceUnavailableException(
      'No free port for the map web server',
    );
  }
}
