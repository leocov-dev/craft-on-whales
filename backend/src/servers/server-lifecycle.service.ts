import { ConflictException, forwardRef, Inject, Injectable, PreconditionFailedException } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { nanoid } from 'nanoid';
import { eq, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import {
  servers,
  schedules,
  backups,
  serverContent,
  serverPacks,
  integrations,
  playerEvents,
  playerSessions,
  playerStatSnapshots,
  crashReports,
  chatCommands,
  chatCommandSettings,
  storageIndex,
  updateChecks,
} from '../db/schema';
import { EventsService } from '../events/events.service';
import { SecretsService } from '../auth/secrets.service';
import { ConfigService } from '../config/config.service';
import { PathGuardService } from '../storage/path-guard.service';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { PortsService } from './ports.service';
import { DockerSpecService } from './docker-spec.service';
import { ContainerService } from '../docker/container.service';
import { DockerImagesService } from '../docker/docker-images.service';
import { ROUTER_NETWORK_NAME } from '../docker/docker-networks.service';
import { DockerLogsService } from '../docker/docker-logs.service';
import { ServerQueryService } from './server-query.service';
import { ServerEnvironmentService } from './server-environment.service';
import { ServerLocksService } from './server-locks.service';
// `import type` (not a normal import) so this class doesn't join the
// synchronous require() cycle ServersModule<->SchedulerModule creates at
// the file level — a plain `import { SchedulerService }` here would drag
// scheduler.service.ts's own require chain (StorageIndexService,
// BackupsService, etc., several of which import ServerLifecycleService
// back) into the middle of THIS file's still-unfinished module evaluation,
// corrupting emitDecoratorMetadata for unrelated constructor params
// elsewhere in the cycle. The runtime class reference for @Inject/forwardRef
// below is obtained via a lazy require() instead, so nothing here is read
// until Nest resolves it post-bootstrap, once every module has finished
// loading.
import type { SchedulerService } from '../scheduler/scheduler.service';
import type { Server, ServerExtraPort, ServerExtraBind } from './types';

export interface CreateServerInput {
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

export interface CreateServerOptions {
  actor?: string;
  start?: boolean;
  onProgress?: (status: string) => void;
  javaTagHint?: string;
}

export interface UpdateServerChanges {
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
  routerHostname?: string | null;
  routerAutoScale?: 'on' | 'off' | null;
  diskQuotaGb?: number;
  autoStart?: boolean;
  autoRestart?: boolean;
  quotaStrict?: boolean;
}

export interface UpdateServerResult {
  server: Server;
  needsRecreate: boolean;
}

/**
 * Server lifecycle: create/start/stop/restart/kill/recreate/delete/update,
 * plus status refresh. The plan's "hub" service for container-lifecycle-facing
 * operations. Judgment call: `updateServer` lives here (not a separate
 * service) since diffing config changes and flagging `pendingRecreate` is
 * lifecycle-adjacent, not env assembly or preview.
 */
@Injectable()
export class ServerLifecycleService {
  constructor(
    private readonly dbService: DbService,
    private readonly events: EventsService,
    private readonly secrets: SecretsService,
    private readonly config: ConfigService,
    private readonly pathGuard: PathGuardService,
    private readonly apiKeys: ApiKeysService,
    private readonly ports: PortsService,
    private readonly dockerSpec: DockerSpecService,
    private readonly containers: ContainerService,
    private readonly images: DockerImagesService,
    private readonly logs: DockerLogsService,
    private readonly query: ServerQueryService,
    private readonly environment: ServerEnvironmentService,
    private readonly locks: ServerLocksService,
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    @Inject(forwardRef(() => require('../scheduler/scheduler.service').SchedulerService))
    private readonly scheduler: SchedulerService
  ) {}

  private get db() {
    return this.dbService.db;
  }

  createServer(input: CreateServerInput, opts: CreateServerOptions = {}): Promise<Server> {
    return this.locks.runSerializedCreate(() => this.createServerImpl(input, opts));
  }

  /**
   * Create a server: DB row + data dir + container. Does not start it unless
   * opts.start. onProgress(status) receives human-readable progress strings.
   * On any failure before the container exists, the half-created row + data
   * dirs are rolled back so no ghost server holds ports.
   */
  private async createServerImpl(
    input: CreateServerInput,
    { actor = 'system', start = false, onProgress = () => {}, javaTagHint }: CreateServerOptions = {}
  ): Promise<Server> {
    // Fail fast instead of shipping a crash-looping container: anything
    // CurseForge needs the API key present in the panel's store.
    const inputEnv = input.env || {};
    const wantsCurseforge = input.type === 'AUTO_CURSEFORGE' || inputEnv.CF_SLUG || inputEnv.CF_FILE_ID || inputEnv.CF_PAGE_URL || inputEnv.CURSEFORGE_FILES;
    if (wantsCurseforge && !this.apiKeys.getKey('curseforge')) {
      throw new PreconditionFailedException(
        'CurseForge needs an API key — add yours in Settings → API keys first (console.curseforge.com), then create the server.'
      );
    }

    const id = `srv_${nanoid(8)}`;

    // Ports: honor explicit choices (validated), else auto-suggest.
    let ports: { game: number; rcon: number; bedrock: number | null };
    if (input.portGame) {
      // The RCON port is derived when not given explicitly — validate the
      // DERIVED value too, or an explicit game port skips collision checks.
      const rcon = input.portRcon || input.portGame + this.config.ports.rconOffset;
      const toCheck = [input.portGame, rcon];
      if (input.portBedrock) toCheck.push(input.portBedrock);
      if (input.portQuery) toCheck.push(input.portQuery);
      for (const p of toCheck) {
        if (!(await this.ports.isPortFree(p))) throw new ConflictException(`Port ${p} is already in use or invalid`);
      }
      ports = { game: input.portGame, rcon, bedrock: input.portBedrock || null };
    } else {
      ports = await this.ports.suggestPorts({ withBedrock: Boolean(input.withBedrock) });
    }

    await this.dockerSpec.validateOverrides({
      containerName: input.containerName,
      networkName: input.networkName,
      extraPorts: input.extraPorts,
      extraBinds: input.extraBinds,
    });

    const rconPassword = this.secrets.generatePassword();
    const defaults = this.config.defaults;

    this.db
      .insert(servers)
      .values({
        id,
        displayName: input.name,
        description: input.description || '',
        icon: input.icon || 'grass',
        accent: input.accent || '#3fa62b',
        tagsJson: JSON.stringify(input.tags || []),
        type: input.type,
        mcVersion: input.mcVersion || 'LATEST',
        javaTag: input.javaTag || '',
        envJson: JSON.stringify(input.env || {}),
        portGame: ports.game,
        portRcon: ports.rcon,
        portQuery: input.portQuery || null,
        portBedrock: ports.bedrock,
        rconPasswordCipher: this.secrets.encrypt(rconPassword),
        heapMb: input.heapMb ?? defaults.heapMb,
        containerMemoryMb: input.containerMemoryMb ?? defaults.containerMemoryMb,
        containerSwapMb: input.containerSwapMb ?? 0,
        cpus: input.cpus ?? defaults.cpus,
        diskQuotaBytes: (input.diskQuotaGb ?? defaults.diskQuotaGb) * 1024 ** 3,
        quotaStrict: Boolean(input.quotaStrict),
        updatePolicy: input.updatePolicy || 'manual',
        autoStart: Boolean(input.autoStart),
        autoRestart: input.autoRestart !== false,
        status: 'stopped',
        containerName: input.containerName || null,
        networkName: input.networkName || null,
        extraPortsJson: JSON.stringify(input.extraPorts || []),
        extraBindsJson: JSON.stringify(input.extraBinds || []),
      })
      .run();

    const server = this.query.getServer(id)!;

    try {
      fs.mkdirSync(this.pathGuard.dataPath('servers', id), { recursive: true });
      fs.mkdirSync(this.pathGuard.dataPath('logs', id, 'events'), { recursive: true });

      const image = this.environment.resolveImage(server, { javaTagHint });
      onProgress(`Pulling image ${image} (first time can take a few minutes)…`);
      await this.images.ensureImage(image, ({ current, total }) => {
        if (total) onProgress(`Downloading image: ${Math.round((current / total) * 100)}%`);
      });

      onProgress('Creating container…');
      const containerId = await this.containers.createContainer({
        serverId: id,
        image,
        env: this.environment.assembleEnv(server),
        dataDir: this.pathGuard.dataPath('servers', id),
        ports: { game: server.port_game, rcon: server.port_rcon, bedrock: server.port_bedrock ?? undefined },
        extraPorts: this.environment.mergeExtraPorts(server),
        resources: { memoryMb: server.container_memory_mb, swapMb: server.container_swap_mb, cpus: server.cpus },
        containerName: server.containerName ?? undefined,
        networkName: server.networkName ?? undefined,
        extraBinds: server.extraBinds,
      });
      this.db.update(servers).set({ containerId }).where(eq(servers.id, id)).run();
    } catch (err: unknown) {
      // Roll back: remove any partial container, drop the row (frees its
      // ports), and delete the freshly-made data/log dirs. Then surface the
      // original error.
      await this.containers.removeContainer(id).catch(() => {});
      this.db.delete(servers).where(eq(servers.id, id)).run();
      try {
        fs.rmSync(this.pathGuard.dataPath('servers', id), { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      try {
        fs.rmSync(this.pathGuard.dataPath('logs', id), { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      if ((err as { statusCode?: number }).statusCode === 409 && input.containerName) {
        throw new ConflictException(`Container name "${input.containerName}" is already in use by another Docker container`);
      }
      throw err;
    }

    this.events.recordEvent({
      serverId: id,
      actor,
      type: 'created',
      summary: `Server created: ${input.name} (${server.type} ${server.mc_version}, port ${ports.game})`,
      details: { type: server.type, mcVersion: server.mc_version, ports },
    });

    if (start) {
      onProgress('Starting server…');
      await this.startServer(id, { actor });
    }
    return this.query.getServer(id)!;
  }

  startServer(id: string, opts: { actor?: string } = {}): Promise<void> {
    return this.locks.guard(id, 'start', () => this.startServerImpl(id, opts));
  }

  stopServer(id: string, opts: { actor?: string } = {}): Promise<void> {
    return this.locks.guard(id, 'stop', () => this.stopServerImpl(id, opts));
  }

  restartServer(id: string, opts: { actor?: string } = {}): Promise<void> {
    return this.locks.guard(id, 'restart', () => this.restartServerImpl(id, opts));
  }

  recreateServer(id: string, opts: { actor?: string; quiet?: boolean } = {}): Promise<void> {
    return this.locks.guard(id, 'recreate', () => this.recreateServerImpl(id, opts));
  }

  private async startServerImpl(id: string, { actor = 'system' }: { actor?: string } = {}): Promise<void> {
    const server = this.query.mustGet(id);
    await this.environment.ensureOwnership(id);
    const info = await this.containers.inspectStatus(id);
    if (!info.exists || server.pending_recreate) {
      await this.recreateServerImpl(id, { actor, quiet: true });
    }
    await this.containers.startContainer(id);
    this.db.update(servers).set({ status: 'starting', lastStartedAt: sql`(datetime('now'))` }).where(eq(servers.id, id)).run();
    this.events.recordEvent({ serverId: id, actor, type: 'started', summary: 'Server start requested' });
  }

  private async stopServerImpl(id: string, { actor = 'system' }: { actor?: string } = {}): Promise<void> {
    this.query.mustGet(id);
    this.events.recordEvent({ serverId: id, actor, type: 'stop-requested', summary: 'Graceful stop requested' });
    await this.containers.stopContainer(id);
    this.db.update(servers).set({ status: 'stopped' }).where(eq(servers.id, id)).run();
    const excerpt = await this.logs.fetchLogs(id, { tail: 100 }).catch(() => '');
    this.events.recordEvent({
      serverId: id,
      actor,
      type: 'stopped',
      summary: 'Server stopped gracefully',
      logExcerpt: excerpt || null,
    });
  }

  private async restartServerImpl(id: string, { actor = 'system' }: { actor?: string } = {}): Promise<void> {
    this.events.recordEvent({ serverId: id, actor, type: 'restart-requested', summary: 'Restart requested' });
    await this.stopServerImpl(id, { actor });
    await this.startServerImpl(id, { actor });
    this.events.recordEvent({ serverId: id, actor, type: 'restarted', summary: 'Server restarted' });
  }

  async killServer(id: string, { actor = 'system' }: { actor?: string } = {}): Promise<void> {
    this.query.mustGet(id);
    this.events.recordEvent({ serverId: id, actor, type: 'kill-requested', summary: 'Force kill requested' });
    await this.containers.killContainer(id);
    this.db.update(servers).set({ status: 'stopped' }).where(eq(servers.id, id)).run();
    this.events.recordEvent({ serverId: id, actor, type: 'killed', summary: 'Server force-killed (world may not have saved)' });
  }

  /** Recreate: remove + create with current env/resources. Applies pending changes. */
  private async recreateServerImpl(id: string, { actor = 'system', quiet = false }: { actor?: string; quiet?: boolean } = {}): Promise<void> {
    const server = this.query.mustGet(id);
    await this.environment.ensureOwnership(id);
    const info = await this.containers.inspectStatus(id);
    const wasRunning = info.exists && ['running', 'starting', 'unhealthy'].includes(info.status);
    if (wasRunning) await this.containers.stopContainer(id);
    await this.containers.removeContainer(id);

    const image = this.environment.resolveImage(server);
    await this.images.ensureImage(image);
    let containerId: string;
    try {
      containerId = await this.containers.createContainer({
        serverId: id,
        image,
        env: this.environment.assembleEnv(server),
        dataDir: this.pathGuard.dataPath('servers', id),
        ports: { game: server.port_game, rcon: server.port_rcon, bedrock: server.port_bedrock ?? undefined },
        extraPorts: this.environment.mergeExtraPorts(server),
        resources: { memoryMb: server.container_memory_mb, swapMb: server.container_swap_mb, cpus: server.cpus },
        containerName: server.containerName ?? undefined,
        networkName: server.networkName ?? undefined,
        extraBinds: server.extraBinds,
        routerHostname: server.routerHostname ?? undefined,
        routerAutoScale: server.routerAutoScale ?? undefined,
      });
    } catch (err: unknown) {
      if ((err as { statusCode?: number }).statusCode === 409 && server.containerName) {
        throw new ConflictException(`Container name "${server.containerName}" is already in use by another Docker container`);
      }
      throw err;
    }
    this.db.update(servers).set({ containerId, pendingRecreate: false }).where(eq(servers.id, id)).run();
    if (!quiet) this.events.recordEvent({ serverId: id, actor, type: 'recreated', summary: 'Container recreated with current configuration' });
    if (wasRunning) await this.startServerImpl(id, { actor });
  }

  /** Update config fields; computes a diff event and flags recreate needs. */
  updateServer(id: string, changes: UpdateServerChanges, { actor = 'system' }: { actor?: string } = {}): UpdateServerResult {
    const before = this.query.mustGet(id);
    const RECREATE_FIELDS = new Set(['mcVersion', 'javaTag', 'heapMb', 'containerMemoryMb', 'cpus']);
    const columns: Record<string, keyof typeof servers.$inferInsert> = {
      name: 'displayName',
      description: 'description',
      icon: 'icon',
      accent: 'accent',
      notes: 'notes',
      mcVersion: 'mcVersion',
      javaTag: 'javaTag',
      heapMb: 'heapMb',
      containerMemoryMb: 'containerMemoryMb',
      cpus: 'cpus',
      updatePolicy: 'updatePolicy',
    };
    const diff: Record<string, unknown> = {};
    const set: Record<string, unknown> = {};
    let needsRecreate = false;

    const changesRec = changes as Record<string, unknown>;
    const beforeRec = before as unknown as Record<string, unknown>;
    for (const [key, col] of Object.entries(columns)) {
      if (changesRec[key] === undefined) continue;
      const beforeVal = key === 'name' ? before.display_name : beforeRec[col];
      if (String(beforeVal) === String(changesRec[key])) continue;
      diff[key] = [beforeVal, changesRec[key]];
      set[col] = changesRec[key];
      if (RECREATE_FIELDS.has(key)) needsRecreate = true;
    }
    if (changes.tags) {
      diff.tags = [before.tags, changes.tags];
      set.tagsJson = JSON.stringify(changes.tags);
    }
    if (changes.env) {
      diff.env = ['(changed)', '(changed)'];
      set.envJson = JSON.stringify(changes.env);
      needsRecreate = true;
    }
    if (changes.containerName !== undefined) {
      const val = changes.containerName ? changes.containerName.trim() : null;
      if (val !== (before.containerName || null)) {
        diff.containerName = [before.containerName, val];
        set.containerName = val;
        needsRecreate = true;
      }
    }
    if (changes.networkName !== undefined) {
      const val = changes.networkName ? changes.networkName.trim() : null;
      if (val !== (before.networkName || null)) {
        diff.networkName = [before.networkName, val];
        set.networkName = val;
        needsRecreate = true;
      }
    }
    if (changes.routerHostname !== undefined) {
      const val = changes.routerHostname ? changes.routerHostname.trim().toLowerCase() : null;
      if (val !== (before.routerHostname || null)) {
        diff.routerHostname = [before.routerHostname, val];
        set.routerHostname = val;
        needsRecreate = true;
        // Routing requires the container on the router's shared network —
        // pin it there whenever a hostname is assigned, unless the caller
        // already picked a network explicitly in this same update.
        if (val && changes.networkName === undefined && before.networkName !== ROUTER_NETWORK_NAME) {
          diff.networkName = [before.networkName, ROUTER_NETWORK_NAME];
          set.networkName = ROUTER_NETWORK_NAME;
        }
      }
    }
    if (changes.routerAutoScale !== undefined) {
      const val = changes.routerAutoScale || null;
      if (val !== (before.routerAutoScale || null)) {
        diff.routerAutoScale = [before.routerAutoScale, val];
        set.routerAutoScale = val;
        needsRecreate = true;
      }
    }
    if (changes.extraPorts !== undefined) {
      diff.extraPorts = ['(changed)', '(changed)'];
      set.extraPortsJson = JSON.stringify(changes.extraPorts);
      needsRecreate = true;
    }
    if (changes.extraBinds !== undefined) {
      diff.extraBinds = ['(changed)', '(changed)'];
      set.extraBindsJson = JSON.stringify(changes.extraBinds);
      needsRecreate = true;
    }
    if (changes.diskQuotaGb !== undefined) {
      diff.diskQuotaGb = [Math.round(before.disk_quota_bytes / 1024 ** 3), changes.diskQuotaGb];
      set.diskQuotaBytes = changes.diskQuotaGb * 1024 ** 3;
    }
    for (const flag of ['autoStart', 'autoRestart', 'quotaStrict'] as const) {
      if (changesRec[flag] === undefined) continue;
      const col = { autoStart: 'autoStart', autoRestart: 'autoRestart', quotaStrict: 'quotaStrict' }[flag];
      const beforeBool = { autoStart: before.auto_start, autoRestart: before.auto_restart, quotaStrict: before.quota_strict }[flag];
      if (Boolean(beforeBool) === Boolean(changesRec[flag])) continue;
      diff[flag] = [Boolean(beforeBool), Boolean(changesRec[flag])];
      set[col] = Boolean(changesRec[flag]);
    }

    if (!Object.keys(set).length) return { server: before, needsRecreate: false };
    if (needsRecreate) set.pendingRecreate = true;
    this.db.update(servers).set(set).where(eq(servers.id, id)).run();
    this.events.recordEvent({
      serverId: id,
      actor,
      type: 'config-changed',
      summary: `Configuration changed: ${Object.keys(diff).join(', ')}${needsRecreate ? ' (recreate required)' : ''}`,
      details: { diff, needsRecreate },
    });
    return { server: this.query.getServer(id)!, needsRecreate };
  }

  /**
   * Delete server: container, DB rows, and (optionally) its data directory.
   *
   * Disarms each live cron job via `SchedulerService.deleteSchedule()`
   * before dropping the rows — `scheduler.ts`/`servers.ts` require each
   * other in the legacy code (a genuine bidirectional cycle per the plan's
   * require-cycle audit), resolved here via `forwardRef()` on both sides.
   */
  async deleteServer(id: string, { actor = 'system', keepWorld = false }: { actor?: string; keepWorld?: boolean } = {}): Promise<{ freedBytes: number }> {
    const server = this.query.mustGet(id);
    await this.containers.stopContainer(id).catch(() => {});
    await this.containers.removeContainer(id);

    // Schedules: disarm the live cron jobs, not just the rows.
    const scheduleRows = this.db.select({ id: schedules.id }).from(schedules).where(eq(schedules.serverId, id)).all();
    for (const sched of scheduleRows) {
      try {
        this.scheduler.deleteSchedule(sched.id, { actor });
      } catch (err: unknown) {
        // eslint-disable-next-line no-console
        console.error(`[delete] schedule ${sched.id}:`, (err as Error).message);
      }
    }
    let freedBytes = 0;
    const dir = this.pathGuard.dataPath('servers', id);
    if (!keepWorld && fs.existsSync(dir)) {
      freedBytes = this.dirSize(dir);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err: unknown) {
        // The itzg container writes files as its own UID (default 1000).
        // When the panel runs as a different host user it can't delete them
        // (EACCES/EPERM); fall back to a root container that removes the
        // directory for us.
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EACCES' || code === 'EPERM') {
          await this.containers.removeDataDir(dir, this.environment.resolveImage(server));
          fs.rmSync(dir, { recursive: true, force: true }); // no-op if the container cleared it
        } else {
          throw err;
        }
      }
    }

    // Full cleanup cascade — without it backups pile up and server_content
    // rows block library deletions forever. (Schedules are already disarmed
    // and deleted above; the transaction's own schedules delete below is a
    // harmless no-op backstop in case a row survived the loop.)
    const backupRows = this.db.select({ sizeBytes: backups.sizeBytes }).from(backups).where(eq(backups.serverId, id)).all();
    freedBytes += backupRows.reduce((n, b) => n + Number(b.sizeBytes || 0), 0);
    const backupsDir = this.pathGuard.dataPath('backups', id);
    if (fs.existsSync(backupsDir)) fs.rmSync(backupsDir, { recursive: true, force: true });

    // Archived logs / event excerpts.
    const logsDir = this.pathGuard.dataPath('logs', id);
    if (fs.existsSync(logsDir)) fs.rmSync(logsDir, { recursive: true, force: true });

    // All row cleanup + the soft-delete flag run in ONE transaction so a
    // mid-cleanup error can't leave a "live" (deleted_at IS NULL) server
    // whose content/backups are already gone — a zombie. Either everything
    // is removed or nothing is.
    const contentIds = this.db.select({ id: serverContent.id }).from(serverContent).where(eq(serverContent.serverId, id)).all().map((r) => r.id);
    this.db.transaction((tx) => {
      tx.delete(updateChecks).where(sql`${updateChecks.subjectType} = 'pack' AND ${updateChecks.subjectId} = ${id}`).run();
      for (const cid of contentIds) {
        tx.delete(updateChecks).where(sql`${updateChecks.subjectType} = 'content' AND ${updateChecks.subjectId} = ${cid}`).run();
      }
      tx.delete(schedules).where(eq(schedules.serverId, id)).run();
      tx.delete(backups).where(eq(backups.serverId, id)).run();
      tx.delete(serverContent).where(eq(serverContent.serverId, id)).run();
      tx.delete(serverPacks).where(eq(serverPacks.serverId, id)).run();
      tx.delete(integrations).where(eq(integrations.serverId, id)).run();
      tx.delete(playerEvents).where(eq(playerEvents.serverId, id)).run();
      tx.delete(playerSessions).where(eq(playerSessions.serverId, id)).run();
      tx.delete(playerStatSnapshots).where(eq(playerStatSnapshots.serverId, id)).run();
      tx.delete(crashReports).where(eq(crashReports.serverId, id)).run();
      // Added: these were previously leaked on delete (no FK cascade).
      tx.delete(chatCommands).where(eq(chatCommands.serverId, id)).run();
      tx.delete(chatCommandSettings).where(eq(chatCommandSettings.serverId, id)).run();
      tx.delete(storageIndex).where(sql`${storageIndex.relPath} = ${`servers/${id}`} OR ${storageIndex.relPath} LIKE ${`servers/${id}/%`}`).run();
      // Keep the soft-deleted server row itself (history retains context).
      tx.update(servers).set({ deletedAt: sql`(datetime('now'))`, status: 'stopped' }).where(eq(servers.id, id)).run();
    });
    this.events.recordEvent({
      serverId: id,
      actor,
      type: 'deleted',
      summary: `Server deleted: ${server.display_name}${keepWorld ? ' (world kept on disk)' : ''}`,
      details: { keepWorld, freedBytes },
    });
    return { freedBytes };
  }

  /** Refresh cached status for all servers from Docker (called on boot + 60s poll). */
  async refreshStatuses(): Promise<void> {
    for (const server of this.query.listServers()) {
      try {
        const info = await this.containers.inspectStatus(server.id);
        let status = info.exists ? info.status : 'stopped';
        // Healthcheck-less containers report 'running' from the moment the
        // process starts, long before the MC server accepts players. Keep
        // the panel's 'starting' until the log shows 'Done (' — but only
        // spend a log fetch on servers stuck 'starting' for over 2 minutes.
        if (server.status === 'starting' && info.exists && info.status === 'running' && info.health == null) {
          const startedMs = Date.parse(String(server.last_started_at || '').replace(' ', 'T') + 'Z');
          if (!Number.isFinite(startedMs) || Date.now() - startedMs > 2 * 60_000) {
            const tail = await this.logs.fetchLogs(server.id, { tail: 50 }).catch(() => '');
            status = /Done \(/.test(tail) ? 'running' : 'starting';
          } else {
            status = 'starting';
          }
        }
        if (status !== server.status) this.db.update(servers).set({ status }).where(eq(servers.id, server.id)).run();
      } catch {
        /* daemon offline — leave cached */
      }
    }
  }

  dirSize(dir: string): number {
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) total += this.dirSize(p);
        else if (entry.isFile()) total += fs.statSync(p).size;
      } catch {
        /* transient file */
      }
    }
    return total;
  }
}
