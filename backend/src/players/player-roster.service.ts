import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import * as fs from 'node:fs';
import { EventsService } from '../events/events.service';
import { PathGuardService } from '../storage/path-guard.service';
import { ContainerService } from '../docker/container.service';
import { MojangProfilesService } from './mojang-profiles.service';
import { PLAYER_NAME_RE, isBedrockName } from '../utils/player-name';
import { parsePlayerList } from '../utils/rcon-list';
import { cleanText as cleanAnsiText } from '../utils/ansi';
import type { PlayerListEntry, BannedIpEntry } from '../../../shared/types/players';

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
}

interface Identity {
  uuid: string;
  name: string;
}

interface RunOptions {
  running?: boolean;
  actor?: string;
}


// Only these fixed filenames are ever touched — no user input reaches a path.
const FILES = new Set(['usercache.json', 'whitelist.json', 'ops.json', 'banned-players.json', 'banned-ips.json']);
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
    private readonly mojangProfiles: MojangProfilesService
  ) {}

  private assertName(name: unknown): string {
    if (!PLAYER_NAME_RE.test(String(name))) {
      throw new BadRequestException('Invalid player name (letters, digits and _ only, max 16 chars — a leading . or * for Bedrock players is fine)');
    }
    return String(name);
  }

  private assertIp(ip: unknown): string {
    if (!IP_RE.test(String(ip))) throw new BadRequestException('Invalid IP address');
    return String(ip);
  }

  /** Reasons/messages travel through RCON — strip control chars so they can't smuggle commands. */
  private cleanText(text: unknown, fallback: string): string {
    const t = String(text || '')
      .replace(/[\r\n\x00-\x1f\x7f]/g, ' ')
      .trim();
    return t || fallback;
  }

  // ---------------------------------------------------------------------- JSON files

  private readJson(serverId: string, file: string): PlayerFileEntry[] {
    if (!FILES.has(file)) throw new BadRequestException(`Unsupported player file: ${file}`);
    try {
      const raw = fs.readFileSync(this.pathGuard.dataPath('servers', serverId, file), 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new BadRequestException(`Could not read ${file}: ${(err as Error).message}`);
    }
  }

  private writeJson(serverId: string, file: string, data: unknown): void {
    if (!FILES.has(file)) throw new BadRequestException(`Unsupported player file: ${file}`);
    const target = this.pathGuard.dataPath('servers', serverId, file);
    const tmp = this.pathGuard.dataPath('servers', serverId, `${file}.tmp`);
    fs.mkdirSync(this.pathGuard.dataPath('servers', serverId), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, target);
  }

  // ---------------------------------------------------------------------- RCON

  private async rcon(serverId: string, ...args: (string | number)[]): Promise<string> {
    // '--' terminates flag parsing: args like '-5' (coords) or names starting
    // with '-' would otherwise be eaten by rcon-cli as flags.
    const out = await this.containers.execCapture(serverId, ['rcon-cli', '--', ...args.map(String)]);
    return String(out || '').trim();
  }

  private assertRunning(running: boolean, what: string): void {
    if (!running) throw new BadRequestException(`Server must be running to ${what}`);
  }

  /**
   * Parse `rcon-cli list` → array of online names. Returns [] when nobody is
   * online. By default also returns [] on an RCON error; pass
   * { throwOnError: true } when the caller must distinguish "confirmed
   * nobody online" from "couldn't ask" (e.g. before an offline .dat edit,
   * where guessing wrong risks corrupting a live player's save).
   */
  async listOnlineNames(serverId: string, { throwOnError = false }: { throwOnError?: boolean } = {}): Promise<string[]> {
    try {
      // rcon-cli colorizes output — strip ANSI/§ codes before parsing, and only
      // accept strict Minecraft name shapes so escapes never become "players".
      const out = cleanAnsiText(await this.rcon(serverId, 'list'));
      const parsed = parsePlayerList(out);
      // Unparseable is "couldn't ask", not "confirmed nobody online" — see the
      // throwOnError note above.
      if (!parsed) throw new ServiceUnavailableException('Could not parse player list from RCON output');
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

  /** Find {uuid, name} in the server's own files (usercache + role files). */
  private localIdentity(serverId: string, name: string): Identity | null {
    const lower = name.toLowerCase();
    for (const file of ['usercache.json', 'whitelist.json', 'ops.json', 'banned-players.json']) {
      const hit = this.readJson(serverId, file).find((e) => e.name && e.name.toLowerCase() === lower && e.uuid);
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
      throw new ServiceUnavailableException(`Could not resolve "${name}" — the player has never joined this server and the Mojang API is unreachable. Try again when online.`);
    }
    if (!profile || !profile.uuid) throw new NotFoundException(`No Minecraft account named "${name}" exists`);
    return { uuid: profile.uuid, name: profile.name };
  }

  // ---------------------------------------------------------------------- read model

  /** Merge every player the server has ever seen into one list. */
  listPlayers(serverId: string, onlineNames: string[] = []): PlayerListEntry[] {
    const entries: PlayerListEntry[] = [];
    const byUuid = new Map<string, PlayerListEntry>();
    const byName = new Map<string, PlayerListEntry>(); // lowercase name — dedupes uuid-less `list` names

    const upsert = (name: string | null | undefined, uuid: string | null | undefined, patch: Partial<PlayerListEntry>): void => {
      if (!name && !uuid) return;
      let entry = (uuid && byUuid.get(uuid)) || (name && byName.get(name.toLowerCase())) || null;
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
          lastSeen: null,
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
      upsert(e.name, e.uuid, { op: true, opLevel: e.level ?? 4, bypassesPlayerLimit: Boolean(e.bypassesPlayerLimit) });
    }
    for (const e of this.readJson(serverId, 'banned-players.json')) {
      upsert(e.name, e.uuid, { banned: true, banReason: e.reason || null, banDate: e.created || null, banSource: e.source || null });
    }
    for (const name of onlineNames) {
      upsert(name, null, { online: true });
    }

    return entries.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  listBannedIps(serverId: string): BannedIpEntry[] {
    return this.readJson(serverId, 'banned-ips.json').map((e) => ({
      ip: e.ip as string,
      reason: e.reason || null,
      created: e.created || null,
      source: e.source || null,
      expires: e.expires || 'forever',
    }));
  }

  // ---------------------------------------------------------------------- whitelist

  async setWhitelisted(serverId: string, name: string, on: boolean, { running = false, actor = 'system' }: RunOptions = {}): Promise<{ name: string; uuid: string; whitelisted: boolean }> {
    const who = await this.resolveIdentity(serverId, name);
    if (running) {
      await this.rcon(serverId, 'whitelist', on ? 'add' : 'remove', who.name);
    } else {
      const list = this.readJson(serverId, 'whitelist.json').filter((e) => e.uuid !== who.uuid);
      if (on) list.push({ uuid: who.uuid, name: who.name });
      this.writeJson(serverId, 'whitelist.json', list);
    }
    this.events.recordEvent({
      serverId,
      actor,
      type: 'player-whitelist',
      summary: `${who.name} ${on ? 'added to' : 'removed from'} the whitelist${running ? '' : ' (file edit — applies on start)'}`,
      details: { name: who.name, uuid: who.uuid, on, via: running ? 'rcon' : 'file' },
    });
    return { name: who.name, uuid: who.uuid, whitelisted: Boolean(on) };
  }

  /** Toggle whitelist enforcement: RCON when running, server.properties otherwise. */
  async setWhitelistEnforced(serverId: string, on: boolean, { running = false, actor = 'system' }: RunOptions = {}): Promise<{ whitelistEnforced: boolean }> {
    if (running) {
      await this.rcon(serverId, 'whitelist', on ? 'on' : 'off');
    } else {
      const file = this.pathGuard.dataPath('servers', serverId, 'server.properties');
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        /* fresh server — create the file */
      }
      if (/^white-list=/m.test(text)) {
        text = text.replace(/^white-list=.*$/m, `white-list=${on}`);
      } else {
        text += `${text && !text.endsWith('\n') ? '\n' : ''}white-list=${on}\n`;
      }
      const tmp = this.pathGuard.dataPath('servers', serverId, 'server.properties.tmp');
      fs.mkdirSync(this.pathGuard.dataPath('servers', serverId), { recursive: true });
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
    }
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
    try {
      const text = fs.readFileSync(this.pathGuard.dataPath('servers', serverId, 'server.properties'), 'utf8');
      const m = /^white-list=(.*)$/m.exec(text);
      return m?.[1] ? m[1].trim() === 'true' : false;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------- ops

  async setOp(serverId: string, name: string, on: boolean, level: number = 4, { running = false, actor = 'system' }: RunOptions = {}): Promise<{ name: string; uuid: string; op: boolean; opLevel: number | null; note: string | null }> {
    const who = await this.resolveIdentity(serverId, name);
    level = Math.min(4, Math.max(1, Number(level) || 4));
    let note: string | null = null;

    const patchOpsFile = () => {
      const list = this.readJson(serverId, 'ops.json').filter((e) => e.uuid !== who.uuid);
      if (on) list.push({ uuid: who.uuid, name: who.name, level, bypassesPlayerLimit: false });
      this.writeJson(serverId, 'ops.json', list);
    };

    if (running) {
      await this.rcon(serverId, on ? 'op' : 'deop', who.name);
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
      summary: on ? `${who.name} opped (level ${level})${running ? '' : ' (file edit — applies on start)'}` : `${who.name} de-opped${running ? '' : ' (file edit — applies on start)'}`,
      details: { name: who.name, uuid: who.uuid, on, level: on ? level : null, via: running ? 'rcon' : 'file' },
    });
    return { name: who.name, uuid: who.uuid, op: Boolean(on), opLevel: on ? level : null, note };
  }

  // ---------------------------------------------------------------------- bans

  async banPlayer(serverId: string, name: string, reasonInput: unknown, { running = false, actor = 'system' }: RunOptions = {}): Promise<{ name: string; uuid: string; banned: true; banReason: string }> {
    const who = await this.resolveIdentity(serverId, name);
    const reason = this.cleanText(reasonInput, 'Banned by an operator.');
    if (running) {
      await this.rcon(serverId, 'ban', who.name, reason);
    } else {
      const list = this.readJson(serverId, 'banned-players.json').filter((e) => e.uuid !== who.uuid);
      list.push({ uuid: who.uuid, name: who.name, created: this.banTimestamp(), source: 'Minecraft Server Manager', expires: 'forever', reason });
      this.writeJson(serverId, 'banned-players.json', list);
    }
    this.events.recordEvent({
      serverId,
      actor,
      type: 'player-ban',
      summary: `${who.name} banned: ${reason}${running ? '' : ' (file edit — applies on start)'}`,
      details: { name: who.name, uuid: who.uuid, reason, via: running ? 'rcon' : 'file' },
    });
    return { name: who.name, uuid: who.uuid, banned: true, banReason: reason };
  }

  async pardonPlayer(serverId: string, name: string, { running = false, actor = 'system' }: RunOptions = {}): Promise<{ name: string; uuid: string; banned: false }> {
    const who = await this.resolveIdentity(serverId, name);
    if (running) {
      await this.rcon(serverId, 'pardon', who.name);
    } else {
      const list = this.readJson(serverId, 'banned-players.json').filter((e) => e.uuid !== who.uuid && (e.name || '').toLowerCase() !== who.name.toLowerCase());
      this.writeJson(serverId, 'banned-players.json', list);
    }
    this.events.recordEvent({
      serverId,
      actor,
      type: 'player-pardon',
      summary: `${who.name} pardoned${running ? '' : ' (file edit — applies on start)'}`,
      details: { name: who.name, uuid: who.uuid, via: running ? 'rcon' : 'file' },
    });
    return { name: who.name, uuid: who.uuid, banned: false };
  }

  async banIp(serverId: string, ipInput: unknown, reasonInput: unknown, { running = false, actor = 'system' }: RunOptions = {}): Promise<{ ip: string; banned: true }> {
    const ip = this.assertIp(ipInput);
    const reason = this.cleanText(reasonInput, 'Banned by an operator.');
    if (running) {
      await this.rcon(serverId, 'ban-ip', ip, reason);
    } else {
      const list = this.readJson(serverId, 'banned-ips.json').filter((e) => e.ip !== ip);
      list.push({ ip, created: this.banTimestamp(), source: 'Minecraft Server Manager', expires: 'forever', reason });
      this.writeJson(serverId, 'banned-ips.json', list);
    }
    this.events.recordEvent({
      serverId,
      actor,
      type: 'player-ban-ip',
      summary: `IP ${ip} banned: ${reason}${running ? '' : ' (file edit — applies on start)'}`,
      details: { ip, reason, via: running ? 'rcon' : 'file' },
    });
    return { ip, banned: true };
  }

  async pardonIp(serverId: string, ipInput: unknown, { running = false, actor = 'system' }: RunOptions = {}): Promise<{ ip: string; banned: false }> {
    const ip = this.assertIp(ipInput);
    if (running) {
      await this.rcon(serverId, 'pardon-ip', ip);
    } else {
      this.writeJson(
        serverId,
        'banned-ips.json',
        this.readJson(serverId, 'banned-ips.json').filter((e) => e.ip !== ip)
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

  // ---------------------------------------------------------------------- kick

  async kickPlayer(serverId: string, name: string, messageInput: unknown, { running = false, actor = 'system' }: RunOptions = {}): Promise<{ name: string; kicked: true }> {
    this.assertName(name);
    this.assertRunning(running, 'kick a player');
    const message = this.cleanText(messageInput, 'Kicked by an operator.');
    const out = await this.rcon(serverId, 'kick', name, message);
    if (/No player was found/i.test(out)) throw new NotFoundException(`${name} is not online`);
    this.events.recordEvent({ serverId, actor, type: 'player-kick', summary: `${name} kicked: ${message}`, details: { name, message } });
    return { name, kicked: true };
  }
}
