import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { isNull } from 'drizzle-orm';
import { ConfigService } from '../config/config.service';
import { SettingsService } from '../settings/settings.service';
import { DbService } from '../db/db.service';
import { servers } from '../db/schema';
import { McRouterDockerService } from '../docker/mc-router-docker.service';
import { DockerNetworksService, ROUTER_NETWORK_NAME } from '../docker/docker-networks.service';
import { DockerConnectionService } from '../docker/docker-connection.service';
import type { McRouterConfig, RouterRoute } from '../../../shared/types/mcRouter';

export type { McRouterConfig, RouterRoute };

const SETTINGS_KEY = 'mc_router';

const DEFAULT_CONFIG: McRouterConfig = {
  enabled: false,
  listenPort: 25565,
  autoScaleUp: true,
  autoScaleDown: true,
  autoScaleDownAfter: '10m',
  autoScaleAsleepMotd: '',
  autoScaleLoadingMotd: '',
};

/**
 * mc-router orchestration: panel-wide settings + the msm-mc-router
 * container's lifecycle. Routing itself (which servers are routed, to which
 * hostname) lives on the `servers` table (`routerHostname`/`routerAutoScale`)
 * and is applied via container labels the normal recreate way — this
 * service only owns the mc-router container + its global config, stored as
 * a single row in the `settings` key-value table (key `mc_router`), matching
 * legacy `src/services/mcRouter.ts` exactly (no dedicated table).
 */
@Injectable()
export class McRouterService {
  constructor(
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
    private readonly dbService: DbService,
    private readonly dockerRouter: McRouterDockerService,
    private readonly dockerNetworks: DockerNetworksService,
    private readonly connection: DockerConnectionService
  ) {}

  getConfig(): McRouterConfig {
    const stored = this.settings.get(SETTINGS_KEY, null) as Partial<McRouterConfig> | null;
    return { ...DEFAULT_CONFIG, ...(stored || {}) };
  }

  setConfig(patch: Partial<McRouterConfig>): McRouterConfig {
    const next = { ...this.getConfig(), ...patch };
    this.settings.set(SETTINGS_KEY, next);
    return next;
  }

  listRoutes(): RouterRoute[] {
    const rows = this.dbService.db
      .select({
        id: servers.id,
        displayName: servers.displayName,
        containerName: servers.containerName,
        routerHostname: servers.routerHostname,
        routerAutoScale: servers.routerAutoScale,
      })
      .from(servers)
      .where(isNull(servers.deletedAt))
      .orderBy(servers.displayName)
      .all();
    return rows.map((r) => ({
      id: r.id,
      name: r.displayName,
      containerName: r.containerName == null ? `msm-${r.id}` : r.containerName,
      hostname: r.routerHostname,
      autoScale: r.routerAutoScale,
    }));
  }

  /**
   * Bring the msm-mc-router container up to date with the current settings.
   * Idempotent: safe to call whenever settings change or at boot. Always
   * remove + recreate rather than diffing — this container carries no state
   * of its own (routing lives on the servers table), so a fresh container is
   * as cheap as it is simple.
   */
  async activate(): Promise<void> {
    const cfg = this.getConfig();
    const socketPath = this.connection.getSocketPath();
    if (!socketPath) {
      throw new InternalServerErrorException(
        'mc-router needs direct access to the Docker socket, which is not available on this platform/configuration (DOCKER_HOST or Windows).'
      );
    }
    const networkName = await this.dockerNetworks.ensureNetwork(ROUTER_NETWORK_NAME);

    const info = await this.dockerRouter.inspectStatus();
    if (info.exists) {
      await this.dockerRouter.stopContainer();
      await this.dockerRouter.removeContainer();
    }
    await this.dockerRouter.createContainer({
      image: this.config.mcRouterImage,
      listenPort: cfg.listenPort,
      networkName,
      dockerSocketPath: socketPath,
      autoScale: {
        up: cfg.autoScaleUp,
        down: cfg.autoScaleDown,
        downAfter: cfg.autoScaleDownAfter,
        asleepMotd: cfg.autoScaleAsleepMotd,
        loadingMotd: cfg.autoScaleLoadingMotd,
      },
    });
    await this.dockerRouter.startContainer();
  }

  async deactivate(): Promise<void> {
    const info = await this.dockerRouter.inspectStatus();
    if (!info.exists) return;
    await this.dockerRouter.stopContainer();
    await this.dockerRouter.removeContainer();
  }

  /** Called at panel boot: bring the container in line with the stored setting. */
  async bootReconcile(): Promise<void> {
    const cfg = this.getConfig();
    if (!cfg.enabled) return;
    await this.activate();
  }
}
