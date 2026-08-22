'use strict';

// Server orchestration: CRUD, env assembly, container lifecycle. The single
// place that turns a DB server row into a running itzg container.

import type { Row } from '../db/types';
import type { Server, ServerExtraPort, ServerExtraBind } from './types';

const httpError = require('../utils/httpError') as typeof import('../utils/httpError');
const fs = require('node:fs');
const path = require('node:path');
const { nanoid } = require('nanoid');
const db = require('../db') as typeof import('../db');
const config = require('../config') as typeof import('../config');
const { dataPath } = require('../storage/pathGuard') as typeof import('../storage/pathGuard');
const { recordEvent } = require('../events') as typeof import('../events');
const secrets = require('./secrets');
const { pickJavaTag } = require('./javaMatrix') as typeof import('./javaMatrix');
const { suggestPorts, isPortFree } = require('./ports') as typeof import('./ports');
const containers = require('../docker/containers') as typeof import('../docker/containers');
const images = require('../docker/images') as typeof import('../docker/images');
const { fetchLogs } = require('../docker/logs') as typeof import('../docker/logs');
const dockerSpec = require('./dockerSpec') as typeof import('./dockerSpec');
const settings = require('./settings');

function rowToServer(row: Row | undefined): Server | null {
  if (!row) return null;
  return {
    id: String(row.id),
    display_name: String(row.display_name),
    description: String(row.description ?? ''),
    icon: String(row.icon ?? 'grass'),
    accent: String(row.accent ?? '#3fa62b'),
    tags: JSON.parse(String(row.tags_json || '[]')) as string[],
    notes: String(row.notes ?? ''),
    type: String(row.type),
    mc_version: String(row.mc_version),
    java_tag: String(row.java_tag ?? ''),
    env: JSON.parse(String(row.env_json || '{}')) as Record<string, string>,
    port_game: Number(row.port_game),
    port_rcon: Number(row.port_rcon),
    port_query: row.port_query == null ? null : Number(row.port_query),
    port_bedrock: row.port_bedrock == null ? null : Number(row.port_bedrock),
    rcon_password_cipher: String(row.rcon_password_cipher),
    heap_mb: Number(row.heap_mb),
    container_memory_mb: Number(row.container_memory_mb),
    container_swap_mb: Number(row.container_swap_mb),
    cpus: Number(row.cpus),
    disk_quota_bytes: Number(row.disk_quota_bytes),
    quota_strict: Number(row.quota_strict),
    update_policy: String(row.update_policy) as Server['update_policy'],
    auto_start: Number(row.auto_start),
    auto_restart: Number(row.auto_restart),
    container_id: row.container_id == null ? null : String(row.container_id),
    pending_recreate: Number(row.pending_recreate),
    status: String(row.status),
    last_started_at: row.last_started_at == null ? null : String(row.last_started_at),
    created_at: String(row.created_at),
    deleted_at: row.deleted_at == null ? null : String(row.deleted_at),
    console_label: row.console_label == null ? null : String(row.console_label),
    container_name: row.container_name == null ? null : String(row.container_name),
    network_name: row.network_name == null ? null : String(row.network_name),
    containerName: row.container_name == null ? null : String(row.container_name),
    networkName: row.network_name == null ? null : String(row.network_name),
    extraPorts: JSON.parse(String(row.extra_ports_json || '[]')) as ServerExtraPort[],
    extraBinds: JSON.parse(String(row.extra_binds_json || '[]')) as ServerExtraBind[],
  };
}

function listServers(): Server[] {
  return (db.all('SELECT * FROM servers WHERE deleted_at IS NULL ORDER BY created_at') as Row[])
    .map(rowToServer)
    .filter((s): s is Server => s !== null);
}

function getServer(id: string): Server | null {
  return rowToServer(db.get('SELECT * FROM servers WHERE id = ? AND deleted_at IS NULL', id));
}

/** The host uid/gid the panel process runs as, or null where it doesn't apply
 *  (Windows / macOS Docker Desktop don't have this bind-mount ownership problem). */
function panelUidGid(): { uid: number; gid: number } | null {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return null;
  return { uid: process.getuid(), gid: process.getgid ? process.getgid() : 0 };
}

/**
 * Assemble the container env from a server row. Panel-owned invariants
 * (EULA, RCON, memory, STOP_DURATION) are applied last so user env in
 * env_json can never break panel management.
 */
function assembleEnv(server: Server): Record<string, string> {
  const env: Record<string, string> = { ...server.env };
  env.EULA = 'TRUE';
  env.TYPE = server.type;
  if (server.mc_version && server.mc_version !== 'LATEST') env.VERSION = server.mc_version;
  env.MEMORY = `${server.heap_mb}M`;
  env.ENABLE_RCON = 'true';
  let rconPassword: string | null = secrets.tryDecrypt(server.rcon_password_cipher);
  if (!rconPassword) {
    // SESSION_SECRET changed — self-heal: mint a fresh password and persist it.
    rconPassword = secrets.generatePassword();
    db.run('UPDATE servers SET rcon_password_cipher = ? WHERE id = ?', secrets.encrypt(rconPassword), server.id);
    recordEvent({
      serverId: server.id,
      type: 'rcon-password-regenerated',
      summary:
        'Stored RCON password could not be decrypted (SESSION_SECRET changed) — a new one was generated automatically',
    });
  }
  env.RCON_PASSWORD = rconPassword!;
  env.STOP_DURATION = env.STOP_DURATION || '60';
  // The itzg image defaults TZ to UTC, which makes the JVM's own console
  // timestamps disagree with every other time shown in the panel (which
  // uses the configured panel timezone). Inherit it unless the user set
  // their own TZ for this server via the advanced env fields.
  env.TZ = env.TZ || settings.getTimezone();
  // CurseForge features need the API key inside the container. It lives in
  // the panel's encrypted store — inject it whenever anything CF is in play.
  const usesCurseforge =
    server.type === 'AUTO_CURSEFORGE' ||
    env.CF_SLUG ||
    env.CF_FILE_ID ||
    env.CF_PAGE_URL ||
    env.CURSEFORGE_FILES ||
    env.CF_MODPACK_ZIP;
  if (usesCurseforge && !env.CF_API_KEY) {
    const cfKey = require('./apiKeys').getKey('curseforge');
    if (cfKey) env.CF_API_KEY = cfKey;
  }
  // The panel is the sole restart authority; never let packs override env.
  delete env.LOAD_ENV_FROM_FILE;
  delete env.LOAD_ENV_FROM_GENERIC_PACK;
  delete env.LOAD_ENV_FROM_ARCHIVE;
  delete env.REMOVE_OLD_MODS;
  // Run the container as the panel's own host user so every file it writes under
  // ./data is owned by us. Otherwise it writes as its default uid (1000) and the
  // panel — a different user — can't manage those files (mod installs, deletes,
  // backups) and hits EACCES. This is the itzg image's intended ownership knob.
  const ids = panelUidGid();
  if (ids) {
    env.UID = String(ids.uid);
    env.GID = String(ids.gid);
  }
  return env;
}

interface ResolveImageOptions {
  javaTagHint?: string;
}

/**
 * javaTagHint: a non-persisted, create-time-only fallback (see createServerImpl).
 * At create time no server_packs row exists yet, so the pin lookup below always
 * misses for a brand-new GTNH server — without the hint that resolves to java17,
 * the image is pulled once, then re-pulled at the correct tag on the recreate
 * `applyPack` schedules moments later. It's never used once a pin exists, and
 * it never overrides an explicit `server.java_tag` (that column means "the user
 * overrode auto" and must keep winning).
 */
function resolveImage(server: Server, { javaTagHint }: ResolveImageOptions = {}): string {
  // GTNH's Java support is a property of the pinned pack version, not of the
  // Minecraft version. Read it straight from the pin: packs.js requires this
  // module, so requiring it back would need a lazy-require cycle-breaker that a
  // single-column read doesn't justify.
  const pin: Row | undefined =
    server.type === 'GTNH'
      ? db.get('SELECT max_java_version FROM server_packs WHERE server_id = ?', server.id)
      : undefined;
  const maxJavaVersion = pin?.max_java_version == null ? undefined : Number(pin.max_java_version);
  const tag =
    server.java_tag ||
    (maxJavaVersion == null && javaTagHint) ||
    pickJavaTag(server.mc_version, server.type, { maxJavaVersion });
  return images.imageRef(tag);
}

/**
 * Combine BlueMap's own (integrations-table-tracked) extra port with the
 * server's user-defined extra ports into the single array `createContainer`
 * expects. Lazily requires ./map — map.js requires this module (for
 * getServer), so a top-level require here would be circular.
 */
function mergeExtraPorts(server: Server): { container: string; host: number | string }[] {
  const bluemapPorts = (require('./map') as typeof import('./map')).extraPortsFor(server.id);
  const userPorts = (server.extraPorts || []).map((p) => ({
    container: `${p.containerPort}/${p.protocol}`,
    host: p.hostPort,
  }));
  return [...bluemapPorts, ...userPorts];
}

interface PreviewCreateSpecInput {
  javaTag?: string;
  mcVersion?: string;
  type?: string;
  env?: Record<string, string>;
  heapMb?: number;
  containerName?: string | null;
  networkName?: string | null;
  containerMemoryMb?: number;
  containerSwapMb?: number;
  cpus?: number;
  portGame?: number;
  portRcon?: number;
  withBedrock?: boolean;
  portBedrock?: number;
  extraPorts?: ServerExtraPort[];
  extraBinds?: ServerExtraBind[];
}

interface PreviewSpec {
  containerName: string | null;
  network: string | null;
  image: string;
  resources: { memoryMb: number; swapMb: number; cpus: number };
  ports: {
    game: number | string;
    rcon: number | string;
    bedrock: number | string | null;
    extra: ServerExtraPort[];
  };
  volumes: {
    data: string;
    extra: ServerExtraBind[];
  };
  env: Record<string, string>;
}

/**
 * Best-effort preview of the container params a `createServer(input)` call
 * would produce — no persistence, no port allocation (unassigned ports show
 * as a placeholder since the real ones aren't claimed until creation).
 * Feeds the wizard's "Advanced Docker Settings" YAML preview.
 */
function previewCreateSpec(input: PreviewCreateSpecInput): PreviewSpec {
  const javaTag = input.javaTag || pickJavaTag(input.mcVersion || 'LATEST', input.type || 'VANILLA');
  const image = images.imageRef(javaTag);
  const defaults = config.defaults;
  const env: Record<string, string> = { ...(input.env || {}) };
  env.EULA = 'TRUE';
  env.TYPE = input.type || 'VANILLA';
  if (input.mcVersion && input.mcVersion !== 'LATEST') env.VERSION = input.mcVersion;
  env.MEMORY = `${input.heapMb ?? defaults.heapMb}M`;
  env.ENABLE_RCON = 'true';
  env.RCON_PASSWORD = '(generated at creation)';
  return {
    containerName: input.containerName || null,
    network: input.networkName || null,
    image,
    resources: {
      memoryMb: input.containerMemoryMb ?? defaults.containerMemoryMb,
      swapMb: input.containerSwapMb ?? 0,
      cpus: input.cpus ?? defaults.cpus,
    },
    ports: {
      game: input.portGame || '(auto-assigned)',
      rcon: input.portRcon || (input.portGame ? input.portGame + config.ports.rconOffset : '(auto-assigned)'),
      bedrock: input.withBedrock ? input.portBedrock || '(auto-assigned)' : null,
      extra: input.extraPorts || [],
    },
    volumes: {
      data: '<panel data dir>/servers/<server id> -> /data',
      extra: input.extraBinds || [],
    },
    env,
  };
}

/** Same shape as previewCreateSpec, but from a real, already-created server. */
function previewServerSpec(id: string): PreviewSpec {
  const server = mustGet(id);
  const env = assembleEnv(server);
  env.RCON_PASSWORD = '(hidden)';
  if (env.CF_API_KEY) env.CF_API_KEY = '(hidden)';
  return {
    containerName: server.containerName || containers.containerName(server.id),
    network: server.networkName || null,
    image: resolveImage(server),
    resources: { memoryMb: server.container_memory_mb, swapMb: server.container_swap_mb, cpus: server.cpus },
    ports: {
      game: server.port_game,
      rcon: server.port_rcon,
      bedrock: server.port_bedrock,
      extra: server.extraPorts,
    },
    volumes: {
      data: `${dataPath('servers', id)} -> /data`,
      extra: server.extraBinds,
    },
    env,
  };
}

// Creates are serialized through this chain so two concurrent creates can't both
// probe the same free port before either has inserted its row (port-allocation
// TOCTOU → duplicate host ports → one un-startable server). Creates are rare, so
// running them one-at-a-time is cheap insurance.
let createChain: Promise<unknown> = Promise.resolve();

interface CreateServerInput {
  name: string;
  description?: string;
  icon?: string;
  accent?: string;
  tags?: string[];
  type: string;
  mcVersion?: string;
  javaTag?: string;
  env?: Record<string, string>;
  portGame?: number;
  portRcon?: number;
  portQuery?: number;
  portBedrock?: number;
  withBedrock?: boolean;
  heapMb?: number;
  containerMemoryMb?: number;
  containerSwapMb?: number;
  cpus?: number;
  diskQuotaGb?: number;
  quotaStrict?: boolean;
  updatePolicy?: string;
  autoStart?: boolean;
  autoRestart?: boolean;
  containerName?: string | null;
  networkName?: string | null;
  extraPorts?: ServerExtraPort[];
  extraBinds?: ServerExtraBind[];
}

interface CreateServerOptions {
  actor?: string;
  start?: boolean;
  onProgress?: (status: string) => void;
  javaTagHint?: string;
}

function createServer(input: CreateServerInput, opts: CreateServerOptions = {}): Promise<Server> {
  const run = () => createServerImpl(input, opts);
  const result = createChain.then(run, run);
  createChain = result.then(
    () => {},
    () => {}
  ); // a failed create must not break the chain
  return result;
}

/**
 * Create a server: DB row + data dir + container. Does not start it unless
 * opts.start. onProgress(status) receives human-readable progress strings.
 * On any failure before the container exists, the half-created row + data dirs
 * are rolled back so no ghost server holds ports.
 */
async function createServerImpl(
  input: CreateServerInput,
  { actor = 'system', start = false, onProgress = () => {}, javaTagHint }: CreateServerOptions = {}
): Promise<Server> {
  // Fail fast instead of shipping a crash-looping container: anything
  // CurseForge needs the API key present in the panel's store.
  const inputEnv = input.env || {};
  const wantsCurseforge =
    input.type === 'AUTO_CURSEFORGE' ||
    inputEnv.CF_SLUG ||
    inputEnv.CF_FILE_ID ||
    inputEnv.CF_PAGE_URL ||
    inputEnv.CURSEFORGE_FILES;
  if (wantsCurseforge && !require('./apiKeys').getKey('curseforge')) {
    throw httpError(
      412,
      'CurseForge needs an API key — add yours in Settings → API keys first (console.curseforge.com), then create the server.'
    );
  }

  const id = `srv_${nanoid(8)}`;

  // Ports: honor explicit choices (validated), else auto-suggest.
  let ports: { game: number; rcon: number; bedrock: number | null };
  if (input.portGame) {
    // The RCON port is derived when not given explicitly — validate the
    // DERIVED value too, or an explicit game port skips collision checks.
    const rcon = input.portRcon || input.portGame + config.ports.rconOffset;
    const toCheck = [input.portGame, rcon];
    if (input.portBedrock) toCheck.push(input.portBedrock);
    if (input.portQuery) toCheck.push(input.portQuery);
    for (const p of toCheck) {
      if (!(await isPortFree(p))) throw httpError(400, `Port ${p} is already in use or invalid`);
    }
    ports = { game: input.portGame, rcon, bedrock: input.portBedrock || null };
  } else {
    ports = await suggestPorts({ withBedrock: Boolean(input.withBedrock) });
  }

  await dockerSpec.validateOverrides({
    containerName: input.containerName,
    networkName: input.networkName,
    extraPorts: input.extraPorts,
    extraBinds: input.extraBinds,
  });

  const rconPassword = secrets.generatePassword();
  const defaults = config.defaults;

  db.run(
    `INSERT INTO servers (id, display_name, description, icon, accent, tags_json, type, mc_version,
       java_tag, env_json, port_game, port_rcon, port_query, port_bedrock, rcon_password_cipher,
       heap_mb, container_memory_mb, container_swap_mb, cpus, disk_quota_bytes, quota_strict,
       update_policy, auto_start, auto_restart, status, container_name, network_name,
       extra_ports_json, extra_binds_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped', ?, ?, ?, ?)`,
    id,
    input.name,
    input.description || '',
    input.icon || 'grass',
    input.accent || '#3fa62b',
    JSON.stringify(input.tags || []),
    input.type,
    input.mcVersion || 'LATEST',
    input.javaTag || '',
    JSON.stringify(input.env || {}),
    ports.game,
    ports.rcon,
    input.portQuery || null,
    ports.bedrock,
    secrets.encrypt(rconPassword),
    input.heapMb ?? defaults.heapMb,
    input.containerMemoryMb ?? defaults.containerMemoryMb,
    input.containerSwapMb ?? 0,
    input.cpus ?? defaults.cpus,
    (input.diskQuotaGb ?? defaults.diskQuotaGb) * 1024 ** 3,
    input.quotaStrict ? 1 : 0,
    input.updatePolicy || 'manual',
    input.autoStart ? 1 : 0,
    input.autoRestart === false ? 0 : 1,
    input.containerName || null,
    input.networkName || null,
    JSON.stringify(input.extraPorts || []),
    JSON.stringify(input.extraBinds || [])
  );

  const server = getServer(id) as Server;

  try {
    fs.mkdirSync(dataPath('servers', id), { recursive: true });
    fs.mkdirSync(dataPath('logs', id, 'events'), { recursive: true });

    const image = resolveImage(server, { javaTagHint });
    onProgress(`Pulling image ${image} (first time can take a few minutes)…`);
    await images.ensureImage(image, ({ current, total }) => {
      if (total) onProgress(`Downloading image: ${Math.round((current / total) * 100)}%`);
    });

    onProgress('Creating container…');
    const containerId = await containers.createContainer({
      serverId: id,
      image,
      env: assembleEnv(server),
      dataDir: dataPath('servers', id),
      ports: { game: server.port_game, rcon: server.port_rcon, bedrock: server.port_bedrock ?? undefined },
      extraPorts: mergeExtraPorts(server),
      resources: { memoryMb: server.container_memory_mb, swapMb: server.container_swap_mb, cpus: server.cpus },
      containerName: server.containerName ?? undefined,
      networkName: server.networkName ?? undefined,
      extraBinds: server.extraBinds,
    });
    db.run('UPDATE servers SET container_id = ? WHERE id = ?', containerId, id);
  } catch (err: unknown) {
    // Roll back: remove any partial container, drop the row (frees its ports),
    // and delete the freshly-made data/log dirs. Then surface the original error.
    await containers.removeContainer(id).catch(() => {});
    db.run('DELETE FROM servers WHERE id = ?', id);
    try {
      fs.rmSync(dataPath('servers', id), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    try {
      fs.rmSync(dataPath('logs', id), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    if ((err as { statusCode?: number }).statusCode === 409 && input.containerName) {
      throw httpError(409, `Container name "${input.containerName}" is already in use by another Docker container`);
    }
    throw err;
  }

  recordEvent({
    serverId: id,
    actor,
    type: 'created',
    summary: `Server created: ${input.name} (${server.type} ${server.mc_version}, port ${ports.game})`,
    details: { type: server.type, mcVersion: server.mc_version, ports },
  });

  if (start) {
    onProgress('Starting server…');
    await startServer(id, { actor });
  }
  return getServer(id) as Server;
}

// ---------------------------------------------------------------------------
// Per-server lifecycle mutex: concurrent start calls share one promise; any
// other overlapping lifecycle op is rejected with 409 instead of racing into
// container-name collisions and half-recreated states.

type LifecycleOp = 'start' | 'stop' | 'restart' | 'recreate';

interface InFlightEntry {
  op: LifecycleOp;
  promise: Promise<unknown>;
}

const inFlightOps = new Map<string, InFlightEntry>(); // serverId -> { op, promise }

function guardOp<T>(
  op: LifecycleOp,
  fn: (id: string, opts: { actor?: string }) => Promise<T>
): (id: string, opts?: { actor?: string }) => Promise<T> {
  return async function guarded(id: string, opts: { actor?: string } = {}): Promise<T> {
    const existing = inFlightOps.get(id);
    if (existing) {
      if (existing.op === op && op === 'start') return existing.promise as Promise<T>; // piggyback on the same start
      throw httpError(409, `Cannot ${op}: a ${existing.op} operation is already in progress for this server`);
    }
    const promise = fn(id, opts);
    const entry: InFlightEntry = { op, promise };
    inFlightOps.set(id, entry);
    try {
      return await promise;
    } finally {
      if (inFlightOps.get(id) === entry) inFlightOps.delete(id);
    }
  };
}

/**
 * Ensure a server's data dir is owned by the panel user so we can manage its
 * files. Containers now run as our uid (see assembleEnv), so this only does real
 * work once — migrating servers created before that, whose files the container
 * wrote as uid 1000. No-op when already aligned or on platforms without uids.
 */
async function ensureOwnership(id: string): Promise<void> {
  const ids = panelUidGid();
  if (!ids) return;
  const dir = dataPath('servers', id);
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    return; // no data dir yet
  }
  if (st.uid === ids.uid && st.gid === ids.gid) return; // already ours — fast path
  await containers.chownDataDir(dir, resolveImage(mustGet(id)), ids.uid, ids.gid);
}

async function startServerImpl(id: string, { actor = 'system' }: { actor?: string } = {}): Promise<void> {
  const server = mustGet(id);
  await ensureOwnership(id);
  const info = await containers.inspectStatus(id);
  if (!info.exists || server.pending_recreate) {
    await recreateServerImpl(id, { actor, quiet: true });
  }
  await containers.startContainer(id);
  db.run("UPDATE servers SET status = 'starting', last_started_at = datetime('now') WHERE id = ?", id);
  recordEvent({ serverId: id, actor, type: 'started', summary: 'Server start requested' });
}

async function stopServerImpl(id: string, { actor = 'system' }: { actor?: string } = {}): Promise<void> {
  mustGet(id);
  recordEvent({ serverId: id, actor, type: 'stop-requested', summary: 'Graceful stop requested' });
  await containers.stopContainer(id);
  db.run("UPDATE servers SET status = 'stopped' WHERE id = ?", id);
  const excerpt = await fetchLogs(id, { tail: 100 }).catch(() => '');
  recordEvent({
    serverId: id,
    actor,
    type: 'stopped',
    summary: 'Server stopped gracefully',
    logExcerpt: excerpt || null,
  });
}

async function restartServerImpl(id: string, { actor = 'system' }: { actor?: string } = {}): Promise<void> {
  recordEvent({ serverId: id, actor, type: 'restart-requested', summary: 'Restart requested' });
  await stopServerImpl(id, { actor });
  await startServerImpl(id, { actor });
  recordEvent({ serverId: id, actor, type: 'restarted', summary: 'Server restarted' });
}

const startServer = guardOp('start', startServerImpl);
const stopServer = guardOp('stop', stopServerImpl);
const restartServer = guardOp('restart', restartServerImpl);

async function killServer(id: string, { actor = 'system' }: { actor?: string } = {}): Promise<void> {
  mustGet(id);
  recordEvent({ serverId: id, actor, type: 'kill-requested', summary: 'Force kill requested' });
  await containers.killContainer(id);
  db.run("UPDATE servers SET status = 'stopped' WHERE id = ?", id);
  recordEvent({ serverId: id, actor, type: 'killed', summary: 'Server force-killed (world may not have saved)' });
}

interface RecreateOptions {
  actor?: string;
  quiet?: boolean;
}

/** Recreate: remove + create with current env/resources. Applies pending changes. */
async function recreateServerImpl(
  id: string,
  { actor = 'system', quiet = false }: RecreateOptions = {}
): Promise<void> {
  const server = mustGet(id);
  await ensureOwnership(id);
  const info = await containers.inspectStatus(id);
  const wasRunning = info.exists && ['running', 'starting', 'unhealthy'].includes(info.status);
  if (wasRunning) await containers.stopContainer(id);
  await containers.removeContainer(id);

  const image = resolveImage(server);
  await images.ensureImage(image);
  let containerId: string;
  try {
    containerId = await containers.createContainer({
      serverId: id,
      image,
      env: assembleEnv(server),
      dataDir: dataPath('servers', id),
      ports: { game: server.port_game, rcon: server.port_rcon, bedrock: server.port_bedrock ?? undefined },
      extraPorts: mergeExtraPorts(server),
      resources: { memoryMb: server.container_memory_mb, swapMb: server.container_swap_mb, cpus: server.cpus },
      containerName: server.containerName ?? undefined,
      networkName: server.networkName ?? undefined,
      extraBinds: server.extraBinds,
    });
  } catch (err: unknown) {
    if ((err as { statusCode?: number }).statusCode === 409 && server.containerName) {
      throw httpError(409, `Container name "${server.containerName}" is already in use by another Docker container`);
    }
    throw err;
  }
  db.run('UPDATE servers SET container_id = ?, pending_recreate = 0 WHERE id = ?', containerId, id);
  if (!quiet)
    recordEvent({ serverId: id, actor, type: 'recreated', summary: 'Container recreated with current configuration' });
  if (wasRunning) await startServerImpl(id, { actor });
}

const recreateServer = guardOp('recreate', recreateServerImpl);

interface UpdateServerChanges {
  name?: string;
  description?: string;
  icon?: string;
  accent?: string;
  notes?: string;
  mcVersion?: string;
  javaTag?: string;
  heapMb?: number;
  containerMemoryMb?: number;
  cpus?: number;
  updatePolicy?: string;
  tags?: string[];
  env?: Record<string, string>;
  containerName?: string | null;
  networkName?: string | null;
  extraPorts?: ServerExtraPort[];
  extraBinds?: ServerExtraBind[];
  diskQuotaGb?: number;
  autoStart?: boolean;
  autoRestart?: boolean;
  quotaStrict?: boolean;
}

interface UpdateServerResult {
  server: Server;
  needsRecreate: boolean;
}

/** Update config fields; computes a diff event and flags recreate needs. */
function updateServer(
  id: string,
  changes: UpdateServerChanges,
  { actor = 'system' }: { actor?: string } = {}
): UpdateServerResult {
  const before = mustGet(id);
  const columns: Record<string, string> = {
    name: 'display_name',
    description: 'description',
    icon: 'icon',
    accent: 'accent',
    notes: 'notes',
    mcVersion: 'mc_version',
    javaTag: 'java_tag',
    heapMb: 'heap_mb',
    containerMemoryMb: 'container_memory_mb',
    cpus: 'cpus',
    updatePolicy: 'update_policy',
  };
  const diff: Record<string, unknown> = {};
  const sets: string[] = [];
  const params: unknown[] = [];
  const RECREATE_FIELDS = new Set(['mcVersion', 'javaTag', 'heapMb', 'containerMemoryMb', 'cpus']);
  let needsRecreate = false;

  const changesRec = changes as Record<string, unknown>;
  const beforeRec = before as unknown as Record<string, unknown>;
  for (const [key, col] of Object.entries(columns)) {
    if (changesRec[key] === undefined) continue;
    const beforeVal = key === 'name' ? before.display_name : beforeRec[col];
    if (String(beforeVal) === String(changesRec[key])) continue;
    diff[key] = [beforeVal, changesRec[key]];
    sets.push(`${col} = ?`);
    params.push(changesRec[key]);
    if (RECREATE_FIELDS.has(key)) needsRecreate = true;
  }
  if (changes.tags) {
    diff.tags = [before.tags, changes.tags];
    sets.push('tags_json = ?');
    params.push(JSON.stringify(changes.tags));
  }
  if (changes.env) {
    diff.env = ['(changed)', '(changed)'];
    sets.push('env_json = ?');
    params.push(JSON.stringify(changes.env));
    needsRecreate = true;
  }
  if (changes.containerName !== undefined) {
    const val = changes.containerName ? changes.containerName.trim() : null;
    if (val !== (before.containerName || null)) {
      diff.containerName = [before.containerName, val];
      sets.push('container_name = ?');
      params.push(val);
      needsRecreate = true;
    }
  }
  if (changes.networkName !== undefined) {
    const val = changes.networkName ? changes.networkName.trim() : null;
    if (val !== (before.networkName || null)) {
      diff.networkName = [before.networkName, val];
      sets.push('network_name = ?');
      params.push(val);
      needsRecreate = true;
    }
  }
  if (changes.extraPorts !== undefined) {
    diff.extraPorts = ['(changed)', '(changed)'];
    sets.push('extra_ports_json = ?');
    params.push(JSON.stringify(changes.extraPorts));
    needsRecreate = true;
  }
  if (changes.extraBinds !== undefined) {
    diff.extraBinds = ['(changed)', '(changed)'];
    sets.push('extra_binds_json = ?');
    params.push(JSON.stringify(changes.extraBinds));
    needsRecreate = true;
  }
  if (changes.diskQuotaGb !== undefined) {
    diff.diskQuotaGb = [Math.round(before.disk_quota_bytes / 1024 ** 3), changes.diskQuotaGb];
    sets.push('disk_quota_bytes = ?');
    params.push(changes.diskQuotaGb * 1024 ** 3);
  }
  for (const flag of ['autoStart', 'autoRestart', 'quotaStrict'] as const) {
    if (changesRec[flag] === undefined) continue;
    const col = { autoStart: 'auto_start', autoRestart: 'auto_restart', quotaStrict: 'quota_strict' }[flag];
    if (Boolean(beforeRec[col]) === Boolean(changesRec[flag])) continue;
    diff[flag] = [Boolean(beforeRec[col]), Boolean(changesRec[flag])];
    sets.push(`${col} = ?`);
    params.push(changesRec[flag] ? 1 : 0);
  }

  if (!sets.length) return { server: before, needsRecreate: false };
  if (needsRecreate) sets.push('pending_recreate = 1');
  db.run(`UPDATE servers SET ${sets.join(', ')} WHERE id = ?`, ...(params as never[]), id);
  recordEvent({
    serverId: id,
    actor,
    type: 'config-changed',
    summary: `Configuration changed: ${Object.keys(diff).join(', ')}${needsRecreate ? ' (recreate required)' : ''}`,
    details: { diff, needsRecreate },
  });
  return { server: getServer(id) as Server, needsRecreate };
}

/** Delete server: container, DB rows, and (optionally) its data directory. */
async function deleteServer(
  id: string,
  { actor = 'system', keepWorld = false }: { actor?: string; keepWorld?: boolean } = {}
): Promise<{ freedBytes: number }> {
  const server = mustGet(id);
  await containers.stopContainer(id).catch(() => {});
  await containers.removeContainer(id);
  let freedBytes = 0;
  const dir = dataPath('servers', id);
  if (!keepWorld && fs.existsSync(dir)) {
    freedBytes = dirSize(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err: unknown) {
      // The itzg container writes files as its own UID (default 1000). When the
      // panel runs as a different host user it can't delete them (EACCES/EPERM);
      // fall back to a root container that removes the directory for us.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        await containers.removeDataDir(dir, resolveImage(server));
        fs.rmSync(dir, { recursive: true, force: true }); // no-op if the container cleared it
      } else {
        throw err;
      }
    }
  }

  // Full cleanup cascade — without it schedules keep firing, backups pile up,
  // and server_content rows block library deletions forever.

  // Schedules: disarm the live cron jobs, not just the rows.
  const scheduler = require('./scheduler') as typeof import('./scheduler'); // lazy — avoids a require cycle
  for (const sched of db.all('SELECT id FROM schedules WHERE server_id = ?', id) as Row[]) {
    try {
      scheduler.deleteSchedule(String(sched.id), { actor });
    } catch (err: unknown) {
      console.error(`[delete] schedule ${sched.id}:`, (err as Error).message);
    }
  }

  // Backups: DB rows + the files directory.
  const backupRows = db.all('SELECT size_bytes FROM backups WHERE server_id = ?', id) as Row[];
  freedBytes += backupRows.reduce((n, b) => n + Number(b.size_bytes || 0), 0);
  db.run('DELETE FROM backups WHERE server_id = ?', id);
  const backupsDir = dataPath('backups', id);
  if (fs.existsSync(backupsDir)) fs.rmSync(backupsDir, { recursive: true, force: true });

  // Archived logs / event excerpts.
  const logsDir = dataPath('logs', id);
  if (fs.existsSync(logsDir)) fs.rmSync(logsDir, { recursive: true, force: true });

  // All row cleanup + the soft-delete flag run in ONE transaction so a mid-cleanup
  // error can't leave a "live" (deleted_at IS NULL) server whose content/backups
  // are already gone — a zombie. Either everything is removed or nothing is.
  const contentIds = (db.all('SELECT id FROM server_content WHERE server_id = ?', id) as Row[]).map((r) =>
    String(r.id)
  );
  db.transaction(() => {
    db.run("DELETE FROM update_checks WHERE subject_type = 'pack' AND subject_id = ?", id);
    for (const cid of contentIds) {
      db.run("DELETE FROM update_checks WHERE subject_type = 'content' AND subject_id = ?", cid);
    }
    db.run('DELETE FROM server_content WHERE server_id = ?', id);
    db.run('DELETE FROM server_packs WHERE server_id = ?', id);
    db.run('DELETE FROM integrations WHERE server_id = ?', id);
    db.run('DELETE FROM player_events WHERE server_id = ?', id);
    db.run('DELETE FROM player_sessions WHERE server_id = ?', id);
    db.run('DELETE FROM player_stat_snapshots WHERE server_id = ?', id);
    db.run('DELETE FROM crash_reports WHERE server_id = ?', id);
    // Added: these were previously leaked on delete (no FK cascade).
    db.run('DELETE FROM chat_commands WHERE server_id = ?', id);
    db.run('DELETE FROM chat_command_settings WHERE server_id = ?', id);
    db.run('DELETE FROM storage_index WHERE rel_path = ? OR rel_path LIKE ?', `servers/${id}`, `servers/${id}/%`);
    // Keep the soft-deleted server row itself (history retains context).
    db.run("UPDATE servers SET deleted_at = datetime('now'), status = 'stopped' WHERE id = ?", id);
  });
  recordEvent({
    serverId: id,
    actor,
    type: 'deleted',
    summary: `Server deleted: ${server.display_name}${keepWorld ? ' (world kept on disk)' : ''}`,
    details: { keepWorld, freedBytes },
  });
  return { freedBytes };
}

/** Refresh cached status for all servers from Docker (called on boot + 60s poll). */
async function refreshStatuses(): Promise<void> {
  for (const server of listServers()) {
    try {
      const info = await containers.inspectStatus(server.id);
      let status = info.exists ? info.status : 'stopped';
      // Healthcheck-less containers report 'running' from the moment the
      // process starts, long before the MC server accepts players. Keep the
      // panel's 'starting' until the log shows 'Done (' — but only spend a
      // log fetch on servers stuck 'starting' for over 2 minutes.
      if (server.status === 'starting' && info.exists && info.status === 'running' && info.health == null) {
        const startedMs = Date.parse(String(server.last_started_at || '').replace(' ', 'T') + 'Z');
        if (!Number.isFinite(startedMs) || Date.now() - startedMs > 2 * 60_000) {
          const tail = await fetchLogs(server.id, { tail: 50 }).catch(() => '');
          status = /Done \(/.test(tail) ? 'running' : 'starting';
        } else {
          status = 'starting';
        }
      }
      if (status !== server.status) db.run('UPDATE servers SET status = ? WHERE id = ?', status, server.id);
    } catch {
      /* daemon offline — leave cached */
    }
  }
}

function dirSize(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirSize(p);
      else if (entry.isFile()) total += fs.statSync(p).size;
    } catch {
      /* transient file */
    }
  }
  return total;
}

function mustGet(id: string): Server {
  const server = getServer(id);
  if (!server) throw httpError(404, 'Server not found');
  return server;
}

/**
 * Set (or clear, when blank) the per-server console label used to prefix
 * panel-run console actions in-game. Strips control chars and § codes.
 * @returns the sanitized label ('' when cleared)
 */
function setConsoleLabel(id: string, label: unknown): string {
  const clean = String(label || '')
    .replace(/[\r\n\x00-\x1f\x7f§]/g, '')
    .trim()
    .slice(0, 48);
  db.run('UPDATE servers SET console_label = ? WHERE id = ?', clean || null, id);
  return clean;
}

export = {
  listServers,
  getServer,
  createServer,
  updateServer,
  deleteServer,
  startServer,
  stopServer,
  restartServer,
  killServer,
  recreateServer,
  refreshStatuses,
  assembleEnv,
  resolveImage,
  ensureOwnership,
  dirSize,
  setConsoleLabel,
  previewCreateSpec,
  previewServerSpec,
};
