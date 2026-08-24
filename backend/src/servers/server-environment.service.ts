import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { servers, serverPacks } from '../db/schema';
import { EventsService } from '../events/events.service';
import { SecretsService } from '../auth/secrets.service';
import { SettingsService } from '../settings/settings.service';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { PathGuardService } from '../storage/path-guard.service';
import { DockerImagesService } from '../docker/docker-images.service';
import { ContainerService } from '../docker/container.service';
import { JavaMatrixService } from './java-matrix.service';
import { ServerQueryService } from './server-query.service';
// `import type` — see MapService's own doc comment on this same cycle
// (ServersModule<->MapModule<->WorldsModule) for why this must be a lazy
// require() at the @Inject site, not a plain import.
import type { MapService } from '../map/map.service';
import type { Server } from './types';

interface ResolveImageOptions {
  javaTagHint?: string;
}

/**
 * Env assembly, image resolution, and per-server filesystem-ownership
 * upkeep. Judgment call (not spelled out verbatim by the plan): `ensureOwnership`
 * and `setConsoleLabel` live here rather than in ServerLifecycleService —
 * both are per-server maintenance operations about the server's *configured
 * state* (its env, its files' ownership, its label), not a lifecycle
 * transition (start/stop/create/delete) or a preview/dry-run.
 */
@Injectable()
export class ServerEnvironmentService {
  private readonly logger = new Logger(ServerEnvironmentService.name);

  constructor(
    private readonly dbService: DbService,
    private readonly events: EventsService,
    private readonly secrets: SecretsService,
    private readonly settings: SettingsService,
    private readonly apiKeys: ApiKeysService,
    private readonly pathGuard: PathGuardService,
    private readonly images: DockerImagesService,
    private readonly containers: ContainerService,
    private readonly javaMatrix: JavaMatrixService,
    private readonly query: ServerQueryService,
    @Inject(forwardRef(() => require('../map/map.service').MapService))
    private readonly map: MapService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  /** The host uid/gid the panel process runs as, or null where it doesn't
   *  apply (Windows / macOS Docker Desktop don't have this bind-mount
   *  ownership problem). */
  panelUidGid(): { uid: number; gid: number } | null {
    if (process.platform === 'win32' || typeof process.getuid !== 'function')
      return null;
    return {
      uid: process.getuid(),
      gid: process.getgid ? process.getgid() : 0,
    };
  }

  /**
   * Assemble the container env from a server row. Panel-owned invariants
   * (EULA, RCON, memory, STOP_DURATION) are applied last so user env in
   * env_json can never break panel management.
   */
  async assembleEnv(server: Server): Promise<Record<string, string>> {
    const env: Record<string, string> = { ...server.env };
    env.EULA = 'TRUE';
    env.TYPE = server.type;
    if (server.mc_version && server.mc_version !== 'LATEST')
      env.VERSION = server.mc_version;
    env.MEMORY = `${server.heap_mb}M`;
    env.ENABLE_RCON = 'true';
    let rconPassword: string | null = this.secrets.tryDecrypt(
      server.rcon_password_cipher,
    );
    if (!rconPassword) {
      // SESSION_SECRET changed — self-heal: mint a fresh password and persist it.
      rconPassword = this.secrets.generatePassword();
      await this.db
        .update(servers)
        .set({ rconPasswordCipher: this.secrets.encrypt(rconPassword) })
        .where(eq(servers.id, server.id));
      this.events.recordEvent({
        serverId: server.id,
        type: 'rcon-password-regenerated',
        summary:
          'Stored RCON password could not be decrypted (SESSION_SECRET changed) — a new one was generated automatically',
      });
    }
    env.RCON_PASSWORD = rconPassword;
    env.STOP_DURATION = env.STOP_DURATION || '60';
    // The itzg image defaults TZ to UTC, which makes the JVM's own console
    // timestamps disagree with every other time shown in the panel (which
    // uses the configured panel timezone). Inherit it unless the user set
    // their own TZ for this server via the advanced env fields.
    env.TZ = env.TZ || (await this.settings.getTimezone());
    // CurseForge features need the API key inside the container. It lives in
    // the panel's encrypted store — inject it whenever anything CF is in play.
    // A packwiz pack can reference CurseForge-hosted mods too (mod.toml's
    // `mode = 'metadata:curseforge'`) — there's no cheap way to know ahead of
    // time whether a given pack does, so inject unconditionally for packwiz,
    // same tradeoff the image itself makes.
    const usesCurseforge =
      server.type === 'AUTO_CURSEFORGE' ||
      server.type === 'PACKWIZ' ||
      env.CF_SLUG ||
      env.CF_FILE_ID ||
      env.CF_PAGE_URL ||
      env.CURSEFORGE_FILES ||
      env.CF_MODPACK_ZIP;
    if (usesCurseforge && !env.CF_API_KEY) {
      const cfKey = await this.apiKeys.getKey('curseforge');
      if (cfKey) env.CF_API_KEY = cfKey;
    }
    // The panel is the sole restart authority; never let packs override env.
    delete env.LOAD_ENV_FROM_FILE;
    delete env.LOAD_ENV_FROM_GENERIC_PACK;
    delete env.LOAD_ENV_FROM_ARCHIVE;
    delete env.REMOVE_OLD_MODS;
    // Run the container as the panel's own host user so every file it writes
    // under ./data is owned by us. Otherwise it writes as its default uid
    // (1000) and the panel — a different user — can't manage those files
    // (mod installs, deletes, backups) and hits EACCES. This is the itzg
    // image's intended ownership knob.
    const ids = this.panelUidGid();
    if (ids) {
      env.UID = String(ids.uid);
      env.GID = String(ids.gid);
    }
    return env;
  }

  /**
   * javaTagHint: a non-persisted, create-time-only fallback. At create time
   * no server_packs row exists yet, so the pin lookup below always misses
   * for a brand-new GTNH server — without the hint that resolves to java17,
   * the image is pulled once, then re-pulled at the correct tag once the
   * pack pin lands moments later. It's never used once a pin exists, and it
   * never overrides an explicit `server.java_tag` (that column means "the
   * user overrode auto" and must keep winning).
   */
  async resolveImage(
    server: Server,
    { javaTagHint }: ResolveImageOptions = {},
  ): Promise<string> {
    // GTNH's Java support is a property of the pinned pack version, not of
    // the Minecraft version — read it straight from server_packs.
    const maxJavaVersion = await this.gtnhMaxJavaVersion(server);
    const tag =
      server.java_tag ||
      (maxJavaVersion == null && javaTagHint) ||
      this.javaMatrix.pickJavaTag(server.mc_version, server.type, {
        maxJavaVersion,
      });
    return this.images.imageRef(tag);
  }

  private async gtnhMaxJavaVersion(
    server: Server,
  ): Promise<number | undefined> {
    if (server.type !== 'GTNH') return undefined;
    const [row] = await this.db
      .select({ maxJavaVersion: serverPacks.maxJavaVersion })
      .from(serverPacks)
      .where(eq(serverPacks.serverId, server.id))
      .limit(1);
    return row?.maxJavaVersion == null ? undefined : Number(row.maxJavaVersion);
  }

  /**
   * Combine BlueMap's own (integrations-table-tracked) extra port with the
   * server's user-defined extra ports into the single array
   * `ContainerService.createContainer` expects.
   */
  async mergeExtraPorts(
    server: Server,
  ): Promise<{ container: string; host: number | string }[]> {
    const bluemapPorts: { container: string; host: number | string }[] =
      await this.map.extraPortsFor(server.id);
    const userPorts = (server.extraPorts || []).map((p) => ({
      container: `${p.containerPort}/${p.protocol}`,
      host: p.hostPort,
    }));
    return [...bluemapPorts, ...userPorts];
  }

  /**
   * Ensure a server's data dir is owned by the panel user so we can manage
   * its files. Containers now run as our uid (see assembleEnv), so this
   * only does real work once — migrating servers created before that, whose
   * files the container wrote as uid 1000. No-op when already aligned or on
   * platforms without uids.
   */
  async ensureOwnership(id: string): Promise<void> {
    const ids = this.panelUidGid();
    if (!ids) return;
    const dir = this.pathGuard.dataPath('servers', id);
    let st;
    try {
      st = fs.statSync(dir);
    } catch {
      return; // no data dir yet
    }
    if (st.uid === ids.uid && st.gid === ids.gid) return; // already ours — fast path
    await this.containers.chownDataDir(
      dir,
      await this.resolveImage(await this.query.mustGet(id)),
      ids.uid,
      ids.gid,
    );
  }

  /**
   * Set (or clear, when blank) the per-server console label used to prefix
   * panel-run console actions in-game. Strips control chars and § codes.
   * @returns the sanitized label ('' when cleared)
   */
  async setConsoleLabel(id: string, label: unknown): Promise<string> {
    const clean = String(label || '')
      .replace(/[\r\n\x00-\x1f\x7f§]/g, '')
      .trim()
      .slice(0, 48);
    await this.dbService.db
      .update(servers)
      .set({ consoleLabel: clean || null })
      .where(eq(servers.id, id));
    return clean;
  }
}
