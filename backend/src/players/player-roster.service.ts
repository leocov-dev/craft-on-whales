import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { EventsService } from '../events/events.service';
import { PathGuardService } from '../storage/path-guard.service';
import { ServerPropertiesService } from '../servers/server-properties.service';
import { ContainerService } from '../docker/container.service';
import { DbService } from '../db/db.service';
import { playerEvents } from '../db/schema';
import { MojangProfilesService } from './mojang-profiles.service';
import { PlayerNotesService } from './player-notes.service';
import { PLAYER_NAME_RE, isBedrockName } from '../utils/player-name';
import { parsePlayerList } from '../utils/rcon-list';
import { rcon } from '../utils/rcon';
// Plain, non-circular import — PlayerDataFileService has no dependency back
// into players/ (same reasoning as player-teleport.service.ts's import of
// it). Reused here (rather than re-deriving the modern/legacy playerdata
// path) so deletePlayer()'s wipe can't drift out of sync with how the
// inventory editor itself resolves a player's .dat file.
import { PlayerDataFileService } from '../inventory/player-data-file.service';
import type {
  PlayerListEntry,
  BannedIpEntry,
} from '../../../shared/types/players';

export type { PlayerListEntry, BannedIpEntry };

/** A raw entry from one of the vanilla player JSON files (usercache/whitelist/ops/bans). */
interface PlayerFileEntry {
  name?: string;
  uuid?: string;
  level?: number;
  bypassesPlayerLimit?: boolean;
  reason?: string;
  created?: string;
  source?: string;
  expires?: string;
  expiresOn?: string;
  ip?: string;
  /** banned-ips.json only — player name this IP ban is tagged as belonging to. */
  player?: string;
}

interface Identity {
  uuid: string;
  name: string;
}

interface RunOptions {
  running?: boolean;
  actor?: string;
}

interface BanRunOptions extends RunOptions {
  /** Ban expires this many ms from now; omitted/undefined = permanent. */
  durationMs?: number;
}

interface BanIpRunOptions extends BanRunOptions {
  /** Player name this IP ban is tagged as belonging to (display only — not enforced by RCON). */
  player?: string;
}

// Only these fixed filenames are ever touched — no user input reaches a path.
const FILES = new Set([
  'usercache.json',
  'whitelist.json',
  'ops.json',
  'banned-players.json',
  'banned-ips.json',
]);
const IP_RE = /^[0-9a-fA-F.:]{3,45}$/;

/**
 * Player god-mode roster service: whitelist/ops/bans/kicks, backed by the
 * server's own JSON files, RCON, and Mojang identity resolution. Every
 * action works both while the server is running (RCON — instant) and, where
 * the file format allows, while it is stopped (direct JSON edits under the
 * server's data dir, applied on next start). Ported from the
 * roster/whitelist/ops/bans/identity sections of src/services/players.ts —
 * teleport/biome/structure logic lives in `PlayerTeleportService` instead
 * (a genuinely separate concern with its own large legacy section).
 */
@Injectable()
export class PlayerRosterService {
  constructor(
    private readonly pathGuard: PathGuardService,
    private readonly events: EventsService,
    private readonly containers: ContainerService,
    private readonly mojangProfiles: MojangProfilesService,
    private readonly properties: ServerPropertiesService,
    private readonly dbService: DbService,
    private readonly playerNotes: PlayerNotesService,
    private readonly playerDataFiles: PlayerDataFileService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  private assertName(name: unknown): string {
    if (!PLAYER_NAME_RE.test(String(name))) {
      throw new BadRequestException(
        'Invalid player name (letters, digits and _ only, max 16 chars — a leading . or * for Bedrock players is fine)',
      );
    }
    return String(name);
  }

  private assertIp(ip: unknown): string {
    if (!IP_RE.test(String(ip)))
      throw new BadRequestException('Invalid IP address');
    return String(ip);
  }

  /** Reasons/messages travel through RCON — strip control chars so they can't smuggle commands. */
  private cleanText(text: unknown, fallback: string): string {
    const t = (typeof text === 'string' ? text : '')
      // eslint-disable-next-line no-control-regex -- intentionally strips control chars
      .replace(/[\r\n\x00-\x1f\x7f]/g, ' ')
      .trim();
    return t || fallback;
  }

  // ---------------------------------------------------------------------- JSON files

  private readJson(serverId: string, file: string): PlayerFileEntry[] {
    if (!FILES.has(file))
      throw new BadRequestException(`Unsupported player file: ${file}`);
    try {
      const raw = fs.readFileSync(
        this.pathGuard.dataPath('servers', serverId, file),
        'utf8',
      );
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as PlayerFileEntry[]) : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new BadRequestException(
        `Could not read ${file}: ${(err as Error).message}`,
      );
    }
  }

  private writeJson(serverId: string, file: string, data: unknown): void {
    if (!FILES.has(file))
      throw new BadRequestException(`Unsupported player file: ${file}`);
    const target = this.pathGuard.dataPath('servers', serverId, file);
    const tmp = this.pathGuard.dataPath('servers', serverId, `${file}.tmp`);
    fs.mkdirSync(this.pathGuard.dataPath('servers', serverId), {
      recursive: true,
    });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, target);
  }

  private assertRunning(running: boolean, what: string): void {
    if (!running)
      throw new BadRequestException(`Server must be running to ${what}`);
  }

  /**
   * Parse `rcon-cli list` → array of online names. Returns [] when nobody is
   * online. By default also returns [] on an RCON error; pass
   * { throwOnError: true } when the caller must distinguish "confirmed
   * nobody online" from "couldn't ask" (e.g. before an offline .dat edit,
   * where guessing wrong risks corrupting a live player's save).
   */
  async listOnlineNames(
    serverId: string,
    { throwOnError = false }: { throwOnError?: boolean } = {},
  ): Promise<string[]> {
    try {
      // rcon-cli colorizes output — strip ANSI/§ codes before parsing, and only
      // accept strict Minecraft name shapes so escapes never become "players".
      const out = await rcon(this.containers, serverId, ['list']);
      const parsed = parsePlayerList(out);
      // Unparseable is "couldn't ask", not "confirmed nobody online" — see the
      // throwOnError note above.
      if (!parsed)
        throw new ServiceUnavailableException(
          'Could not parse player list from RCON output',
        );
      return parsed.names;
    } catch (err) {
      if (throwOnError) throw err;
      return [];
    }
  }

  // ---------------------------------------------------------------------- identity

  /** 'yyyy-MM-dd HH:mm:ss +0000' — the vanilla ban-file timestamp format. */
  private banTimestamp(date: Date = new Date()): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())} ${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())} +0000`;
  }

  private static readonly BAN_TIMESTAMP_RE =
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) \+0000$/;

  /** Inverse of banTimestamp(); null for 'forever'/absent or anything unparseable. */
  private banTimestampToMs(expires: unknown): number | null {
    const m = PlayerRosterService.BAN_TIMESTAMP_RE.exec(
      typeof expires === 'string' ? expires : '',
    );
    if (!m) return null;
    const [, y, mo, d, h, mi, s] = m;
    return Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(s),
    );
  }

  /**
   * Lazy expiry check — mirrors the pattern SessionService uses for expired
   * sessions (compare a stored timestamp against Date.now() at read time,
   * no background timer). Vanilla itself already ignores an expired ban on
   * connect; this just decides how the panel reads/displays the still-there
   * file entry until something writes the file again (a pardon, another
   * ban, etc.) — harmless since vanilla itself already ignores it on
   * connect, and every panel read already treats it as pardoned.
   */
  private isBanExpired(expires: unknown): boolean {
    const ms = this.banTimestampToMs(expires);
    return ms !== null && ms <= Date.now();
  }

  /** Find {uuid, name} in the server's own files (usercache + role files). */
  private localIdentity(serverId: string, name: string): Identity | null {
    const lower = name.toLowerCase();
    for (const file of [
      'usercache.json',
      'whitelist.json',
      'ops.json',
      'banned-players.json',
    ]) {
      const hit = this.readJson(serverId, file).find(
        (e) => e.name && e.name.toLowerCase() === lower && e.uuid,
      );
      if (hit) return { uuid: hit.uuid as string, name: hit.name as string };
    }
    return null;
  }

  /** Resolve a name to {uuid, name}: server files first, Mojang API second. */
  async resolveIdentity(serverId: string, name: string): Promise<Identity> {
    this.assertName(name);
    const local = this.localIdentity(serverId, name);
    if (local) return local;
    let profile: { uuid: string | null; name: string } | null = null;
    try {
      profile = await this.mojangProfiles.resolveProfile(name);
    } catch {
      throw new ServiceUnavailableException(
        `Could not resolve "${name}" — the player has never joined this server and the Mojang API is unreachable. Try again when online.`,
      );
    }
    if (!profile || !profile.uuid)
      throw new NotFoundException(
        `No Minecraft account named "${name}" exists`,
      );
    return { uuid: profile.uuid, name: profile.name };
  }

  // ---------------------------------------------------------------------- read model

  /** Merge every player the server has ever seen into one list. */
  listPlayers(serverId: string, onlineNames: string[] = []): PlayerListEntry[] {
    const entries: PlayerListEntry[] = [];
    const byUuid = new Map<string, PlayerListEntry>();
    const byName = new Map<string, PlayerListEntry>(); // lowercase name — dedupes uuid-less `list` names

    const upsert = (
      name: string | null | undefined,
      uuid: string | null | undefined,
      patch: Partial<PlayerListEntry>,
    ): void => {
      if (!name && !uuid) return;
      let entry =
        (uuid && byUuid.get(uuid)) ||
        (name && byName.get(name.toLowerCase())) ||
        null;
      if (!entry) {
        entry = {
          name: name || '(unknown)',
          bedrock: isBedrockName(name),
          uuid: null,
          online: false,
          whitelisted: false,
          op: false,
          opLevel: null,
          bypassesPlayerLimit: false,
          banned: false,
          banReason: null,
          banDate: null,
          banSource: null,
          banExpires: null,
          lastSeen: null,
          lastKnownIp: null,
        };
        entries.push(entry);
      }
      if (uuid && !entry.uuid) {
        entry.uuid = uuid;
        byUuid.set(uuid, entry);
      }
      if (name) {
        entry.name = name;
        entry.bedrock = isBedrockName(name);
        byName.set(name.toLowerCase(), entry);
      } // canonical casing from files
      Object.assign(entry, patch);
    };

    for (const e of this.readJson(serverId, 'usercache.json')) {
      upsert(e.name, e.uuid, { lastSeen: e.expiresOn || null });
    }
    for (const e of this.readJson(serverId, 'whitelist.json')) {
      upsert(e.name, e.uuid, { whitelisted: true });
    }
    for (const e of this.readJson(serverId, 'ops.json')) {
      upsert(e.name, e.uuid, {
        op: true,
        opLevel: e.level ?? 4,
        bypassesPlayerLimit: Boolean(e.bypassesPlayerLimit),
      });
    }
    for (const e of this.readJson(serverId, 'banned-players.json')) {
      // An expired entry still sits in the file until the next sweep (or
      // vanilla's own check on connect) actually removes it — display it as
      // pardoned rather than confusingly still "banned" in the meantime.
      const expired = this.isBanExpired(e.expires);
      upsert(e.name, e.uuid, {
        banned: !expired,
        banReason: expired ? null : e.reason || null,
        banDate: expired ? null : e.created || null,
        banSource: expired ? null : e.source || null,
        banExpires:
          expired || !e.expires || e.expires === 'forever' ? null : e.expires,
      });
    }
    for (const name of onlineNames) {
      upsert(name, null, { online: true });
    }

    return entries.sort(
      (a, b) =>
        Number(b.online) - Number(a.online) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
  }

  listBannedIps(serverId: string): BannedIpEntry[] {
    return this.readJson(serverId, 'banned-ips.json')
      .filter((e) => !this.isBanExpired(e.expires))
      .map((e) => ({
        ip: e.ip as string,
        reason: e.reason || null,
        created: e.created || null,
        source: e.source || null,
        expires: e.expires || 'forever',
        player: e.player || null,
      }));
  }

  // ---------------------------------------------------------------------- whitelist

  async setWhitelisted(
    serverId: string,
    name: string,
    on: boolean,
    { running = false, actor = 'system' }: RunOptions = {},
  ): Promise<{ name: string; uuid: string; whitelisted: boolean }> {
    const who = await this.resolveIdentity(serverId, name);
    if (running) {
      await rcon(this.containers, serverId, [
        'whitelist',
        on ? 'add' : 'remove',
        who.name,
      ]);
    } else {
      const list = this.readJson(serverId, 'whitelist.json').filter(
        (e) => e.uuid !== who.uuid,
      );
      if (on) list.push({ uuid: who.uuid, name: who.name });
      this.writeJson(serverId, 'whitelist.json', list);
    }
    this.events.recordEvent({
      serverId,
      actor,
      type: 'player-whitelist',
      summary: `${who.name} ${on ? 'added to' : 'removed from'} the whitelist${running ? '' : ' (file edit — applies on start)'}`,
      details: {
        name: who.name,
        uuid: who.uuid,
        on,
        via: running ? 'rcon' : 'file',
      },
    });
    return { name: who.name, uuid: who.uuid, whitelisted: Boolean(on) };
  }

  /** Toggle whitelist enforcement: RCON when running, server.properties otherwise. */
  async setWhitelistEnforced(
    serverId: string,
    on: boolean,
    { running = false, actor = 'system' }: RunOptions = {},
  ): Promise<{ whitelistEnforced: boolean }> {
    if (running) {
      // Toggling the whitelist live makes the game rewrite the whole of
      // server.properties from the values it loaded at boot, wiping any edit
      // made since — preserveEdits puts ours back. `white-list` is the one
      // key the game is right about here.
      await this.properties.preserveEdits(serverId, ['white-list'], () =>
        rcon(this.containers, serverId, ['whitelist', on ? 'on' : 'off']),
      );
    }
    // Write the file either way: it is what the server reads on boot, and
    // this is also what clears an ENABLE_WHITELIST env var that would
    // otherwise revert the toggle on the next start.
    await this.properties.setProperty(serverId, 'white-list', String(on), {
      actor,
    });
    this.events.recordEvent({
      serverId,
      actor,
      type: 'player-whitelist-enforce',
      summary: `Whitelist enforcement turned ${on ? 'on' : 'off'}${running ? '' : ' (file edit — applies on start)'}`,
      details: { on, via: running ? 'rcon' : 'file' },
    });
    return { whitelistEnforced: Boolean(on) };
  }

  /** Parse server.properties for white-list= (defaults false when absent). */
  getWhitelistEnforced(serverId: string): boolean {
    return this.properties.get(serverId, 'white-list') === 'true';
  }

  // ---------------------------------------------------------------------- ops

  async setOp(
    serverId: string,
    name: string,
    on: boolean,
    level: number = 4,
    { running = false, actor = 'system' }: RunOptions = {},
  ): Promise<{
    name: string;
    uuid: string;
    op: boolean;
    opLevel: number | null;
    note: string | null;
  }> {
    const who = await this.resolveIdentity(serverId, name);
    level = Math.min(4, Math.max(1, Number(level) || 4));
    let note: string | null = null;

    const patchOpsFile = () => {
      const list = this.readJson(serverId, 'ops.json').filter(
        (e) => e.uuid !== who.uuid,
      );
      if (on)
        list.push({
          uuid: who.uuid,
          name: who.name,
          level,
          bypassesPlayerLimit: false,
        });
      this.writeJson(serverId, 'ops.json', list);
    };

    if (running) {
      await rcon(this.containers, serverId, [on ? 'op' : 'deop', who.name]);
      if (on && level !== 4) {
        // RCON `op` always grants level 4 — persist the requested level for next boot.
        patchOpsFile();
        note = `RCON op grants level 4 for this session; level ${level} is saved to ops.json and takes effect after a restart.`;
      }
    } else {
      patchOpsFile();
    }

    this.events.recordEvent({
      serverId,
      actor,
      type: on ? 'player-op' : 'player-deop',
      summary: on
        ? `${who.name} opped (level ${level})${running ? '' : ' (file edit — applies on start)'}`
        : `${who.name} de-opped${running ? '' : ' (file edit — applies on start)'}`,
      details: {
        name: who.name,
        uuid: who.uuid,
        on,
        level: on ? level : null,
        via: running ? 'rcon' : 'file',
      },
    });
    return {
      name: who.name,
      uuid: who.uuid,
      op: Boolean(on),
      opLevel: on ? level : null,
      note,
    };
  }

  // ---------------------------------------------------------------------- bans

  async banPlayer(
    serverId: string,
    name: string,
    reasonInput: unknown,
    { running = false, actor = 'system', durationMs }: BanRunOptions = {},
  ): Promise<{
    name: string;
    uuid: string;
    banned: true;
    banReason: string;
    banExpires: string | null;
  }> {
    const who = await this.resolveIdentity(serverId, name);
    const reason = this.cleanText(reasonInput, 'Banned by an operator.');
    const expires = durationMs
      ? this.banTimestamp(new Date(Date.now() + durationMs))
      : 'forever';
    if (running)
      await rcon(this.containers, serverId, ['ban', who.name, reason]);
    // RCON's own `ban` always writes 'forever' to the file — and when
    // stopped we have to write the file ourselves anyway — so (re)write the
    // entry whenever a real expiry was requested.
    if (!running || durationMs) {
      const list = this.readJson(serverId, 'banned-players.json').filter(
        (e) => e.uuid !== who.uuid,
      );
      list.push({
        uuid: who.uuid,
        name: who.name,
        created: this.banTimestamp(),
        source: 'Minecraft Server Manager',
        expires,
        reason,
      });
      this.writeJson(serverId, 'banned-players.json', list);
    }
    this.events.recordEvent({
      serverId,
      actor,
      type: 'player-ban',
      summary: `${who.name} banned${durationMs ? ` until ${expires}` : ''}: ${reason}${running ? '' : ' (file edit — applies on start)'}`,
      details: {
        name: who.name,
        uuid: who.uuid,
        reason,
        expires,
        via: running ? 'rcon' : 'file',
      },
    });
    return {
      name: who.name,
      uuid: who.uuid,
      banned: true,
      banReason: reason,
      banExpires: durationMs ? expires : null,
    };
  }

  async pardonPlayer(
    serverId: string,
    name: string,
    { running = false, actor = 'system' }: RunOptions = {},
  ): Promise<{ name: string; uuid: string; banned: false }> {
    const who = await this.resolveIdentity(serverId, name);
    if (running) {
      await rcon(this.containers, serverId, ['pardon', who.name]);
    } else {
      const list = this.readJson(serverId, 'banned-players.json').filter(
        (e) =>
          e.uuid !== who.uuid &&
          (e.name || '').toLowerCase() !== who.name.toLowerCase(),
      );
      this.writeJson(serverId, 'banned-players.json', list);
    }
    this.events.recordEvent({
      serverId,
      actor,
      type: 'player-pardon',
      summary: `${who.name} pardoned${running ? '' : ' (file edit — applies on start)'}`,
      details: {
        name: who.name,
        uuid: who.uuid,
        via: running ? 'rcon' : 'file',
      },
    });
    return { name: who.name, uuid: who.uuid, banned: false };
  }

  async banIp(
    serverId: string,
    ipInput: unknown,
    reasonInput: unknown,
    {
      running = false,
      actor = 'system',
      durationMs,
      player,
    }: BanIpRunOptions = {},
  ): Promise<{
    ip: string;
    banned: true;
    banExpires: string | null;
    player: string | null;
  }> {
    const ip = this.assertIp(ipInput);
    const reason = this.cleanText(reasonInput, 'Banned by an operator.');
    const expires = durationMs
      ? this.banTimestamp(new Date(Date.now() + durationMs))
      : 'forever';
    const linkedPlayer = player ? this.assertName(player) : null;
    if (running) await rcon(this.containers, serverId, ['ban-ip', ip, reason]);
    // Same story as banPlayer: RCON always writes 'forever' and has no idea
    // about the player-linkage tag, so (re)write the entry whenever either
    // extension is used.
    if (!running || durationMs || linkedPlayer) {
      const list = this.readJson(serverId, 'banned-ips.json').filter(
        (e) => e.ip !== ip,
      );
      list.push({
        ip,
        created: this.banTimestamp(),
        source: 'Minecraft Server Manager',
        expires,
        reason,
        player: linkedPlayer || undefined,
      });
      this.writeJson(serverId, 'banned-ips.json', list);
    }
    this.events.recordEvent({
      serverId,
      actor,
      type: 'player-ban-ip',
      summary: `IP ${ip} banned${durationMs ? ` until ${expires}` : ''}${linkedPlayer ? ` (linked to ${linkedPlayer})` : ''}: ${reason}${running ? '' : ' (file edit — applies on start)'}`,
      details: {
        ip,
        reason,
        expires,
        player: linkedPlayer,
        via: running ? 'rcon' : 'file',
      },
    });
    return {
      ip,
      banned: true,
      banExpires: durationMs ? expires : null,
      player: linkedPlayer,
    };
  }

  async pardonIp(
    serverId: string,
    ipInput: unknown,
    { running = false, actor = 'system' }: RunOptions = {},
  ): Promise<{ ip: string; banned: false }> {
    const ip = this.assertIp(ipInput);
    if (running) {
      await rcon(this.containers, serverId, ['pardon-ip', ip]);
    } else {
      this.writeJson(
        serverId,
        'banned-ips.json',
        this.readJson(serverId, 'banned-ips.json').filter((e) => e.ip !== ip),
      );
    }
    this.events.recordEvent({
      serverId,
      actor,
      type: 'player-pardon-ip',
      summary: `IP ${ip} pardoned${running ? '' : ' (file edit — applies on start)'}`,
      details: { ip, via: running ? 'rcon' : 'file' },
    });
    return { ip, banned: false };
  }

  // ------------------------------------------------------------- last-known IP

  /**
   * Most recent join IP the console logged for this player on this server
   * (from the "<player>[/<ip>] logged in with entity id" line —
   * `LogClassifierService` strips the port; `LogIngestService` persists it
   * as a `player_events` row of type 'join' with `target` = the IP). Null
   * when nothing was ever captured (never joined, or joined before this
   * feature/analytics ingestion was enabled). Powers the optional "also ban
   * this IP" step on the ban dialog — see PLAYERS_NOTES.md for why this
   * doesn't need any new IP-capture plumbing.
   */
  async getLastKnownIp(serverId: string, name: string): Promise<string | null> {
    // Most recent joins first; a handful of rows back covers the (rare)
    // case where the very latest join line raced ingestion and landed
    // without its IP — no need for a real GROUP BY/aggregate query here.
    const rows = await this.db
      .select({ target: playerEvents.target })
      .from(playerEvents)
      .where(
        and(
          eq(playerEvents.serverId, serverId),
          eq(playerEvents.player, name),
          eq(playerEvents.type, 'join'),
        ),
      )
      .orderBy(desc(playerEvents.id))
      .limit(20);
    const hit = rows.find((r) => r.target);
    return hit ? hit.target : null;
  }

  // ---------------------------------------------------------------- delete player

  private static readonly ROLE_FILES = [
    'usercache.json',
    'whitelist.json',
    'ops.json',
    'banned-players.json',
  ];

  /** Drop every entry matching a player's uuid (lowercase-name fallback) from a role file. */
  private stripPlayerFromFile(
    serverId: string,
    file: string,
    who: Identity,
  ): void {
    const lower = who.name.toLowerCase();
    const remaining = this.readJson(serverId, file).filter(
      (e) => e.uuid !== who.uuid && (e.name || '').toLowerCase() !== lower,
    );
    this.writeJson(serverId, file, remaining);
  }

  /**
   * Permanently remove a player from this server's panel-visible state:
   * every entry in usercache/whitelist/ops/banned-players, their offline
   * playerdata (.dat/.dat_old, modern + legacy layout), their inventory
   * snapshots, and their moderator notes. Irreversible — there is no undo.
   *
   * Refused while the player is online: a live player's role entries would
   * just get re-minted by the running JVM the moment it next writes those
   * files, and a running world keeps a live .dat in memory that would
   * overwrite whatever we delete on its own next save. See PLAYERS_NOTES.md.
   */
  async deletePlayer(
    serverId: string,
    name: string,
    { running = false, actor = 'system' }: RunOptions = {},
  ): Promise<{
    name: string;
    uuid: string;
    removed: { playerdata: number; snapshots: boolean; notes: number };
  }> {
    const who = await this.resolveIdentity(serverId, name);
    if (running) {
      const online = await this.listOnlineNames(serverId, {
        throwOnError: true,
      }).catch(() => [] as string[]);
      if (online.some((n) => n.toLowerCase() === who.name.toLowerCase())) {
        throw new ConflictException(
          `${who.name} is still online — kick them or wait for them to leave before deleting their data`,
        );
      }
      // Clear roles over RCON first so the JVM (which may still rewrite
      // whitelist.json/ops.json/banned-players.json from its in-memory
      // state on its own schedule) can't resurrect what we're about to
      // delete from the files out from under us.
      await rcon(this.containers, serverId, ['deop', who.name]).catch(() => {});
      await rcon(this.containers, serverId, [
        'whitelist',
        'remove',
        who.name,
      ]).catch(() => {});
      await rcon(this.containers, serverId, ['pardon', who.name]).catch(
        () => {},
      );
    }

    for (const file of PlayerRosterService.ROLE_FILES) {
      this.stripPlayerFromFile(serverId, file, who);
    }

    const removed = { playerdata: 0, snapshots: false, notes: 0 };
    try {
      const dir = await this.playerDataFiles.playerdataDir(serverId);
      for (const ext of ['.dat', '.dat_old']) {
        const file = path.join(dir, `${who.uuid}${ext}`);
        if (fs.existsSync(file)) {
          fs.rmSync(file, { force: true });
          removed.playerdata += 1;
        }
      }
    } catch {
      /* server/world may not exist yet — role-file cleanup above already ran */
    }
    try {
      fs.rmSync(
        this.pathGuard.dataPath('logs', serverId, 'inventories', who.uuid),
        {
          recursive: true,
          force: true,
        },
      );
      removed.snapshots = true;
    } catch {
      /* no snapshots */
    }
    removed.notes = await this.playerNotes.deletePlayerNotes(
      serverId,
      who.uuid,
    );

    this.events.recordEvent({
      serverId,
      actor,
      type: 'player-deleted',
      summary: `${who.name} and all their panel data were deleted`,
      details: { name: who.name, uuid: who.uuid, removed },
    });
    return { name: who.name, uuid: who.uuid, removed };
  }

  // ---------------------------------------------------------------------- kick

  async kickPlayer(
    serverId: string,
    name: string,
    messageInput: unknown,
    { running = false, actor = 'system' }: RunOptions = {},
  ): Promise<{ name: string; kicked: true }> {
    this.assertName(name);
    this.assertRunning(running, 'kick a player');
    const message = this.cleanText(messageInput, 'Kicked by an operator.');
    const out = await rcon(this.containers, serverId, ['kick', name, message]);
    if (/No player was found/i.test(out))
      throw new NotFoundException(`${name} is not online`);
    this.events.recordEvent({
      serverId,
      actor,
      type: 'player-kick',
      summary: `${name} kicked: ${message}`,
      details: { name, message },
    });
    return { name, kicked: true };
  }
}
