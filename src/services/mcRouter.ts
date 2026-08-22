'use strict';

// mc-router orchestration: panel-wide settings + the msm-mc-router container's
// lifecycle. Routing itself (which servers are routed, to which hostname) lives
// on the servers table (router_hostname/router_auto_scale, see services/servers.js)
// and is applied to a server's container labels the normal recreate way — this
// module only owns the mc-router container + its global config.

import type { Row } from '../db/types';

const { config } = require('../config') as typeof import('../config');
const settings = require('./settings') as typeof import('./settings');
const dockerRouter = require('../docker/mcRouter') as typeof import('../docker/mcRouter');
const dockerNetworks = require('../docker/networks') as typeof import('../docker/networks');
const { getSocketPath } = require('../docker/connect') as typeof import('../docker/connect');
const { dbApi: db } = require('../db') as typeof import('../db');

const SETTINGS_KEY = 'mc_router';

interface McRouterConfig {
  enabled: boolean;
  listenPort: number;
  autoScaleUp: boolean;
  autoScaleDown: boolean;
  autoScaleDownAfter: string;
  autoScaleAsleepMotd: string;
  autoScaleLoadingMotd: string;
}

const DEFAULT_CONFIG: McRouterConfig = {
  enabled: false,
  listenPort: 25565,
  autoScaleUp: true,
  autoScaleDown: true,
  autoScaleDownAfter: '10m',
  autoScaleAsleepMotd: '',
  autoScaleLoadingMotd: '',
};

function getConfig(): McRouterConfig {
  const stored = settings.get(SETTINGS_KEY, null) as Partial<McRouterConfig> | null;
  return { ...DEFAULT_CONFIG, ...(stored || {}) };
}

function setConfig(patch: Partial<McRouterConfig>): McRouterConfig {
  const next = { ...getConfig(), ...patch };
  settings.set(SETTINGS_KEY, next);
  return next;
}

interface RouterRoute {
  id: string;
  name: string;
  containerName: string;
  hostname: string | null;
  autoScale: string | null;
}

function listRoutes(): RouterRoute[] {
  const rows = db.all(
    `SELECT id, display_name, container_name, router_hostname, router_auto_scale
     FROM servers WHERE deleted_at IS NULL ORDER BY display_name`
  ) as Row[];
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.display_name),
    containerName: r.container_name == null ? `msm-${String(r.id)}` : String(r.container_name),
    hostname: r.router_hostname == null ? null : String(r.router_hostname),
    autoScale: r.router_auto_scale == null ? null : String(r.router_auto_scale),
  }));
}

/**
 * Bring the msm-mc-router container up to date with the current settings.
 * Idempotent: safe to call whenever settings change or at boot. Always
 * remove + recreate rather than diffing — this container carries no state
 * of its own (routing lives on the servers table), so a fresh container is
 * as cheap as it is simple.
 */
async function activate(): Promise<void> {
  const cfg = getConfig();
  const socketPath = getSocketPath();
  if (!socketPath) {
    throw new Error(
      'mc-router needs direct access to the Docker socket, which is not available on this platform/configuration (DOCKER_HOST or Windows).'
    );
  }
  const networkName = await dockerNetworks.ensureNetwork(dockerNetworks.ROUTER_NETWORK_NAME);

  const info = await dockerRouter.inspectStatus();
  if (info.exists) {
    await dockerRouter.stopContainer();
    await dockerRouter.removeContainer();
  }
  await dockerRouter.createContainer({
    image: config.mcRouterImage,
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
  await dockerRouter.startContainer();
}

async function deactivate(): Promise<void> {
  const info = await dockerRouter.inspectStatus();
  if (!info.exists) return;
  await dockerRouter.stopContainer();
  await dockerRouter.removeContainer();
}

/** Called at panel boot: bring the container in line with the stored setting. */
async function bootReconcile(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.enabled) return;
  await activate();
}

export { getConfig, setConfig, listRoutes, activate, deactivate, bootReconcile };
export type { McRouterConfig, RouterRoute };
