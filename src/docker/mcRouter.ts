'use strict';

// Container lifecycle for the mc-router integration. A single, panel-owned
// container (msm-mc-router) using mc-router's Docker discovery connector
// (-in-docker) to auto-route + auto-scale servers labeled mc-router.host
// (set by docker/containers.js createContainer when a server has a router
// hostname). See src/services/mcRouter.js for the orchestration that keeps
// this container's settings in sync with the panel's mc_router setting.

import type Dockerode from 'dockerode';

const { getDocker } = require('./connect') as typeof import('./connect');

const CONTAINER_NAME = 'msm-mc-router';
const LISTEN_PORT = '25565'; // mc-router's internal listen port; matches the itzg image's default game port

function containerName(): string {
  return CONTAINER_NAME;
}

interface AutoScaleSpec {
  up: boolean;
  down: boolean;
  downAfter: string;
  asleepMotd: string;
  loadingMotd: string;
}

interface CreateContainerSpec {
  image: string;
  listenPort: number;
  networkName: string;
  dockerSocketPath: string;
  autoScale: AutoScaleSpec;
}

async function createContainer(spec: CreateContainerSpec): Promise<string> {
  const docker = getDocker();
  const env: Record<string, string> = {
    IN_DOCKER: 'true',
    PORT: LISTEN_PORT,
    AUTO_SCALE_UP: String(spec.autoScale.up),
    AUTO_SCALE_DOWN: String(spec.autoScale.down),
    AUTO_SCALE_DOWN_AFTER: spec.autoScale.downAfter,
  };
  if (spec.autoScale.asleepMotd) env.AUTO_SCALE_ASLEEP_MOTD = spec.autoScale.asleepMotd;
  if (spec.autoScale.loadingMotd) env.AUTO_SCALE_LOADING_MOTD = spec.autoScale.loadingMotd;

  const hostConfig: Dockerode.HostConfig = {
    Binds: [`${spec.dockerSocketPath}:/var/run/docker.sock`],
    PortBindings: {
      [`${LISTEN_PORT}/tcp`]: [{ HostPort: String(spec.listenPort) }],
    },
    NetworkMode: spec.networkName,
    RestartPolicy: { Name: 'no' }, // the panel owns lifecycle, via mc_router.enabled
  };

  const container = await docker.createContainer({
    name: CONTAINER_NAME,
    Image: spec.image,
    // The itzg mc-router image runs as a non-root user by default, which
    // can't read/write the bind-mounted Docker socket — run as root instead
    // of fiddling with host-specific docker group GIDs (see README's Docker
    // socket permission notes). Same tradeoff docker/containers.js already
    // makes for its own throwaway root helper containers.
    User: '0:0',
    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    Labels: { 'msm.managed': 'true', 'msm.role': 'mc-router' },
    ExposedPorts: { [`${LISTEN_PORT}/tcp`]: {} },
    Tty: false,
    OpenStdin: false,
    HostConfig: hostConfig,
  });
  return container.id;
}

function getContainer(): Dockerode.Container {
  return getDocker().getContainer(CONTAINER_NAME);
}

interface InspectStatusResult {
  exists: boolean;
  status: 'starting' | 'unhealthy' | 'running' | 'stopped' | 'crashed';
  containerId?: string;
}

async function inspectStatus(): Promise<InspectStatusResult> {
  try {
    const info = await getContainer().inspect();
    const s = info.State;
    let status: InspectStatusResult['status'];
    if (s.Running) status = 'running';
    else if (s.Status === 'created') status = 'stopped';
    else status = s.ExitCode === 0 ? 'stopped' : 'crashed';
    return { exists: true, status, containerId: info.Id };
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) return { exists: false, status: 'stopped' };
    throw err;
  }
}

async function startContainer(): Promise<void> {
  await getContainer().start();
}

async function stopContainer(): Promise<void> {
  try {
    await getContainer().stop();
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode !== 404 && statusCode !== 304) throw err; // 304 = already stopped
  }
}

async function removeContainer(): Promise<void> {
  try {
    await getContainer().remove({ force: true });
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err;
  }
}

export { containerName, createContainer, inspectStatus, startContainer, stopContainer, removeContainer };
