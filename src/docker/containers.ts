'use strict';

// Container lifecycle for managed Minecraft servers. All containers are
// labeled msm.id=<serverId> and named msm-<serverId>.

import type Dockerode from 'dockerode';
import type { Row } from '../db/types';

const path = require('node:path');
const { PassThrough } = require('node:stream');
const { getDocker } = require('./connect') as typeof import('./connect');
const { toHostPath } = require('./hostPath');
const db = require('../db');

const LABEL = 'msm.id';
const GAME_PORT = '25565';
const RCON_PORT = '25575';
const BEDROCK_PORT = '19132';

function containerName(serverId: string): string {
  return `msm-${serverId}`;
}

interface ExtraPort {
  container: string;
  host: number | string;
}

interface ExtraBind {
  hostPath: string;
  containerPath: string;
  mode?: 'rw' | 'ro';
}

interface CreateContainerSpec {
  serverId: string;
  /** e.g. itzg/minecraft-server:java21 */
  image: string;
  /** flat { KEY: 'value' } */
  env: Record<string, string>;
  /** absolute panel-local data dir, re-rooted to the host and bind-mounted to /data */
  dataDir: string;
  /** { game, rcon, bedrock? } host ports */
  ports: { game: number | string; rcon: number | string; bedrock?: number | string };
  /** { memoryMb, swapMb, cpus } */
  resources: { memoryMb: number; swapMb?: number; cpus?: number };
  /** Docker container name override; default `msm-<serverId>` */
  containerName?: string;
  /** existing host Docker network to attach to; default bridge */
  networkName?: string;
  /** feature ports (e.g. BlueMap's web server) + user-defined extras */
  extraPorts?: ExtraPort[];
  /** RAW host paths, not re-rooted */
  extraBinds?: ExtraBind[];
}

/**
 * Create (but do not start) a container for a server.
 */
async function createContainer(spec: CreateContainerSpec): Promise<string> {
  const docker = getDocker();
  const exposed: Record<string, Record<string, never>> = {
    [`${GAME_PORT}/tcp`]: {},
    [`${GAME_PORT}/udp`]: {}, // query protocol shares the game port
    [`${RCON_PORT}/tcp`]: {},
  };
  const bindings: Record<string, Array<{ HostPort: string }>> = {
    [`${GAME_PORT}/tcp`]: [{ HostPort: String(spec.ports.game) }],
    [`${GAME_PORT}/udp`]: [{ HostPort: String(spec.ports.game) }],
    [`${RCON_PORT}/tcp`]: [{ HostPort: String(spec.ports.rcon) }],
  };
  if (spec.ports.bedrock) {
    exposed[`${BEDROCK_PORT}/udp`] = {};
    bindings[`${BEDROCK_PORT}/udp`] = [{ HostPort: String(spec.ports.bedrock) }];
  }
  // Feature ports (e.g. BlueMap's web server) + user-defined extras — [{container: '8100/tcp', host: 8123}]
  for (const extra of spec.extraPorts || []) {
    exposed[extra.container] = {};
    bindings[extra.container] = [{ HostPort: String(extra.host) }];
  }

  const memoryBytes = Math.round(spec.resources.memoryMb * 1024 * 1024);
  const swapBytes = memoryBytes + Math.round((spec.resources.swapMb || 0) * 1024 * 1024);

  // Extra binds are already HOST paths (the admin types the real host
  // location), unlike dataDir which is panel-local and must be re-rooted —
  // running them through toHostPath would reject anything outside DATA_DIR,
  // which is the entire point of this escape hatch.
  const extraBindStrings = (spec.extraBinds || []).map(
    (b) => `${b.hostPath}:${b.containerPath}${b.mode === 'ro' ? ':ro' : ''}`
  );

  const hostConfig: Dockerode.HostConfig = {
    Binds: [`${toHostPath(spec.dataDir)}:/data`, ...extraBindStrings],
    PortBindings: bindings,
    Memory: memoryBytes,
    MemorySwap: swapBytes,
    NanoCpus: spec.resources.cpus ? Math.round(spec.resources.cpus * 1e9) : 0,
    RestartPolicy: { Name: 'no' }, // the panel owns restarts (crash backoff, quota stops)
  };
  if (spec.networkName) hostConfig.NetworkMode = spec.networkName;

  const container = await docker.createContainer({
    name: spec.containerName || containerName(spec.serverId),
    Image: spec.image,
    Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
    Labels: { [LABEL]: spec.serverId, 'msm.managed': 'true' },
    ExposedPorts: exposed,
    Tty: false,
    OpenStdin: false,
    HostConfig: hostConfig,
  });
  return container.id;
}

/** Resolve the actual Docker name for a server — its custom name if one was set, else msm-<id>. */
function resolvedName(serverId: string): string {
  const row: Row | undefined = db.get('SELECT container_name FROM servers WHERE id = ?', serverId);
  return (row && (row.container_name as string | null)) || containerName(serverId);
}

function getContainer(serverId: string): Dockerode.Container {
  return getDocker().getContainer(resolvedName(serverId));
}

interface InspectStatusResult {
  exists: boolean;
  status: 'starting' | 'unhealthy' | 'running' | 'stopped' | 'crashed';
  health?: string | null;
  exitCode?: number | null;
  startedAt?: string | null;
  finishedAt?: string;
  oomKilled?: boolean;
  containerId?: string;
}

/** Inspect → panel status. Returns { status, health, exitCode, startedAt, pid }. */
async function inspectStatus(serverId: string): Promise<InspectStatusResult> {
  try {
    const info = await getContainer(serverId).inspect();
    const s = info.State;
    const health = s.Health ? s.Health.Status : null; // starting | healthy | unhealthy
    let status: InspectStatusResult['status'];
    if (s.Running) {
      if (health === 'starting') status = 'starting';
      else if (health === 'unhealthy') status = 'unhealthy';
      else status = 'running';
    } else if (s.Status === 'created') {
      status = 'stopped';
    } else {
      status = s.ExitCode === 0 ? 'stopped' : 'crashed';
    }
    return {
      exists: true,
      status,
      health,
      exitCode: s.Running ? null : s.ExitCode,
      startedAt: s.Running ? s.StartedAt : null,
      finishedAt: s.FinishedAt,
      oomKilled: Boolean(s.OOMKilled),
      containerId: info.Id,
    };
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 404) return { exists: false, status: 'stopped' };
    throw err;
  }
}

async function startContainer(serverId: string): Promise<void> {
  await getContainer(serverId).start();
}

interface StopContainerOptions {
  graceSeconds?: number;
}

/**
 * Graceful stop: send `stop` over rcon-cli inside the container (no password
 * needed via exec), then wait; fall back to docker stop with a generous grace
 * period so the world always saves.
 */
async function stopContainer(serverId: string, { graceSeconds = 90 }: StopContainerOptions = {}): Promise<void> {
  const container = getContainer(serverId);
  try {
    // Send the in-game `stop` (saves the world). execCapture reads + destroys the
    // exec stream and has a timeout, so we don't leak a hijacked connection here.
    await execCapture(serverId, ['rcon-cli', 'stop'], { timeoutMs: 15000 }).catch(() => {});
    // Wait for the container to exit on its own after the stop command.
    await Promise.race([container.wait(), new Promise((resolve) => setTimeout(resolve, graceSeconds * 1000).unref())]);
  } catch {
    // rcon unavailable (early boot, crashed loop) — fall through to docker stop
  }
  const info = await inspectStatus(serverId);
  if (info.exists && (info.status === 'running' || info.status === 'starting' || info.status === 'unhealthy')) {
    await container.stop({ t: graceSeconds });
  }
}

async function killContainer(serverId: string): Promise<void> {
  try {
    await getContainer(serverId).kill();
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode !== 404 && statusCode !== 409) throw err; // 409 = not running
  }
}

async function removeContainer(serverId: string): Promise<void> {
  try {
    await getContainer(serverId).remove({ force: true });
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err;
  }
}

interface ExecRawOptions {
  timeoutMs?: number;
  wantExitCode?: boolean;
}

interface ExecRawResult {
  stdout: string;
  exitCode: number | null;
}

/**
 * Run a command via docker exec and capture its raw output (+ exit code on
 * request). A timeout guards against a hung exec (unresponsive/deadlocked JVM)
 * leaving the hijacked stream + connection open forever — critical because
 * liveCache fires this on an interval and hung calls would otherwise stack
 * without bound.
 */
async function execRaw(
  serverId: string,
  cmd: string[],
  { timeoutMs = 15000, wantExitCode = false }: ExecRawOptions = {}
): Promise<ExecRawResult> {
  const container = getContainer(serverId);
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({});
  const stdout: string = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    // Demux the Docker stream framing (8-byte headers).
    const out: NodeJS.WritableStream = new PassThrough();
    out.on('data', (b: Buffer) => chunks.push(b));
    getDocker().modem.demuxStream(stream, out, out);
    let settled = false;
    // fn is either `resolve` (string) or `reject` (Error) — genuinely
    // polymorphic, so it's typed loosely rather than forcing a false union.
    const finish = (fn: (arg: any) => void, arg: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        stream.destroy();
      } catch {
        /* already gone */
      }
      fn(arg);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`exec timed out after ${timeoutMs}ms: ${cmd.join(' ')}`)),
      timeoutMs
    );
    timer.unref?.();
    stream.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
    stream.on('error', (err: Error) => finish(reject, err));
  });
  // The inspect is a second daemon round trip, opted into by the one caller
  // that reads the code — everyone else skips both its cost and its failure
  // modes. It must never hang past the timeout contract above, and it must
  // never fail a command whose output was already captured: the exit code is
  // best-effort, and null means "unknown" (callers already treat non-zero and
  // unknown the same, as "not a confirmed success").
  let exitCode: number | null = null;
  if (wantExitCode) {
    try {
      const inspected = await Promise.race([
        exec.inspect(),
        new Promise<null>((resolve) => setTimeout(resolve, timeoutMs, null).unref?.()),
      ]);
      if (inspected && typeof inspected.ExitCode === 'number') exitCode = inspected.ExitCode;
    } catch {
      /* exit code stays unknown */
    }
  }
  return { stdout, exitCode };
}

/** Run a command via docker exec and capture its output (used for rcon-cli). */
async function execCapture(serverId: string, cmd: string[], opts: ExecRawOptions = {}): Promise<string> {
  const { stdout } = await execRaw(serverId, cmd, opts);
  return stdout;
}

/**
 * Like execCapture, but also resolves the command's exit code so callers can
 * tell "ran successfully but printed something unexpected" apart from "the
 * command itself failed" (e.g. rcon-cli exits non-zero and prints a connection
 * error to stderr when RCON isn't listening yet — docker exec itself still
 * succeeds since the container process is running, so execCapture alone can't
 * distinguish that from a genuine, parseable response). The code is best-effort:
 * `exitCode` is null when the daemon didn't answer the inspect in time, which
 * callers must treat as "not a confirmed success", never as an error.
 */
async function execCaptureChecked(serverId: string, cmd: string[], opts: ExecRawOptions = {}): Promise<ExecRawResult> {
  return execRaw(serverId, cmd, { ...opts, wantExitCode: true });
}

/**
 * Delete a server's data directory using a throwaway root container.
 *
 * The itzg image writes world/mod files as its own UID (default 1000). When the
 * panel process runs as a different host user it can't remove them — `rm` fails
 * with EACCES. Root inside a container can delete files of any UID, so we mount
 * the PARENT directory and remove the target by name. `Cmd: []` is required so
 * the image's default CMD isn't appended as extra arguments to our entrypoint.
 */
async function removeDataDir(dir: string, image: string): Promise<void> {
  const docker = getDocker();
  const parent = path.dirname(dir);
  const base = path.basename(dir);
  const container = await docker.createContainer({
    Image: image,
    Entrypoint: ['rm', '-rf', `/work/${base}`],
    Cmd: [],
    User: '0:0',
    Labels: { 'msm.managed': 'true', 'msm.role': 'cleanup' },
    HostConfig: { Binds: [`${toHostPath(parent)}:/work`], AutoRemove: false, NetworkMode: 'none' },
  });
  try {
    await container.start();
    const res = await container.wait(); // rm exits 0 on success
    if (res && res.StatusCode !== 0) {
      throw new Error(`cleanup container exited ${res.StatusCode} while removing ${base}`);
    }
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}

/**
 * Chown a server's data directory to uid:gid using a throwaway root container.
 * Migrates servers whose files the container wrote under its old default uid so
 * the panel (running as uid:gid) can manage them. Mounts the PARENT and chowns
 * the target by name; `Cmd: []` clears the image's default CMD (see removeDataDir).
 */
async function chownDataDir(dir: string, image: string, uid: number | string, gid: number | string): Promise<void> {
  const docker = getDocker();
  const parent = path.dirname(dir);
  const base = path.basename(dir);
  const container = await docker.createContainer({
    Image: image,
    Entrypoint: ['chown', '-R', `${uid}:${gid}`, `/work/${base}`],
    Cmd: [],
    User: '0:0',
    Labels: { 'msm.managed': 'true', 'msm.role': 'chown' },
    HostConfig: { Binds: [`${toHostPath(parent)}:/work`], AutoRemove: false, NetworkMode: 'none' },
  });
  try {
    await container.start();
    const res = await container.wait();
    if (res && res.StatusCode !== 0) {
      throw new Error(`chown container exited ${res.StatusCode} for ${base}`);
    }
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}

export = {
  LABEL,
  containerName,
  createContainer,
  getContainer,
  inspectStatus,
  startContainer,
  stopContainer,
  killContainer,
  removeContainer,
  removeDataDir,
  chownDataDir,
  execCapture,
  execCaptureChecked,
};
