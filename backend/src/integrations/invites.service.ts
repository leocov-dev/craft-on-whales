import { Injectable, NotFoundException } from '@nestjs/common';
import * as fs from 'node:fs';
import * as os from 'node:os';
// @types/archiver has no factory-function signature (only the Archiver
// class) — matching the untyped-require pattern established in
// backend/src/worlds/world-archive.service.ts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const archiver = require('archiver');
import { and, eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { PathGuardService } from '../storage/path-guard.service';
import { ServerQueryService } from '../servers/server-query.service';
import { ModsService } from '../mods/mods.service';
import { ModrinthApiService } from '../mods/modrinth-api.service';
import { MojangService } from '../players/mojang.service';
import { PlayerRosterService } from '../players/player-roster.service';
import { serverContent, libraryFiles } from '../db/schema';
import { displayVersion, flavorLabel } from './view-labels.util';
import type { GenerateMrpackResult, InviteInfo } from './integrations.types';
import type { Server } from '../servers/types';

/** Non-internal local IPv4 addresses, LAN-looking ones first. */
function localIPv4s(): string[] {
  const ips: string[] = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips.sort((a, b) => Number(isLan(b)) - Number(isLan(a)));
}

function isLan(ip: string): boolean {
  return /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
}

function portForwardGuidance(port: number): string {
  return [
    `To let friends outside your network join, forward TCP port ${port} on your router to this machine.`,
    'Open your router admin page (usually 192.168.1.1 or 192.168.0.1), find "Port Forwarding" (sometimes under NAT or Virtual Server),',
    `and add a rule: external port ${port} → this computer's LAN IP, port ${port}, protocol TCP.`,
    'Then share your public IP with the port. If your ISP uses CGNAT, port forwarding will not work — consider a tunnel (e.g. playit.gg) instead.',
  ].join(' ');
}

function isPluginFlavor(type: string): boolean {
  // Plugin servers (Paper & friends) need nothing on the client.
  return [
    'PAPER',
    'PURPUR',
    'PUFFERFISH',
    'LEAF',
    'FOLIA',
    'SPIGOT',
    'BUKKIT',
    'CANYON',
  ].includes(type);
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'server'
  );
}

// itzg env var → Modrinth loader dependency id
const LOADER_ENVS: Record<string, string> = {
  FABRIC_LOADER_VERSION: 'fabric-loader',
  QUILT_LOADER_VERSION: 'quilt-loader',
  FORGE_VERSION: 'forge',
  NEOFORGE_VERSION: 'neoforge',
};

type OverlayRow = {
  name: string;
  filename: string;
  enabled: boolean;
  platform: string | null;
  fileId: string | null;
};

/**
 * Invites & client modpack generation (MP7). Ports `src/integrations/invites.ts`.
 * - inviteInfo: everything a friend needs to join (address candidates, version,
 *   flavor, whitelist state) plus a ready-to-paste text block.
 * - generateMrpack: Modrinth-format client pack built from the server's overlay
 *   mods, with a hand-written servers.dat in overrides/ so launchers (Prism,
 *   Modrinth App) pre-add the server to the multiplayer list.
 * - No UPnP: we detect the public IP (ipify, cached 1h) and give manual
 *   port-forward guidance instead.
 */
@Injectable()
export class InvitesService {
  private publicIpCache: { ip: string | null; at: number } = {
    ip: null,
    at: 0,
  };

  constructor(
    private readonly dbService: DbService,
    private readonly pathGuard: PathGuardService,
    private readonly serverQuery: ServerQueryService,
    private readonly mods: ModsService,
    private readonly modrinth: ModrinthApiService,
    private readonly mojang: MojangService,
    private readonly players: PlayerRosterService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  private async mustGet(serverId: string): Promise<Server> {
    const server = await this.serverQuery.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');
    return server;
  }

  // -------------------------------------------------------------------
  // Public IP detection (replaces UPnP — no new dependencies).

  async detectPublicIp(): Promise<string | null> {
    if (Date.now() - this.publicIpCache.at < 60 * 60 * 1000)
      return this.publicIpCache.ip;
    try {
      const res = await fetch('https://api.ipify.org', {
        signal: AbortSignal.timeout(5000),
      });
      const ip = res.ok ? (await res.text()).trim() : null;
      this.publicIpCache = {
        ip: /^[\d.]+$/.test(ip || '') ? ip : null,
        at: Date.now(),
      };
    } catch {
      this.publicIpCache = { ip: null, at: Date.now() };
    }
    return this.publicIpCache.ip;
  }

  // -------------------------------------------------------------------
  // Invite info

  async inviteInfo(serverId: string): Promise<InviteInfo> {
    const server = await this.mustGet(serverId);
    const port = server.port_game;
    const candidates = localIPv4s().map((ip) => `${ip}:${port}`);

    const mcVersion = await displayVersion(this.mojang, server.mc_version);
    const flavor = flavorLabel(server.type);
    const whitelistEnforced = this.players.getWhitelistEnforced(serverId);

    const content = await this.mods.listContent(serverId).catch(() => []);
    const activeMods = content.filter(
      (m) =>
        m.enabled && !m.missing && (m.kind === 'mod' || m.kind === 'plugin'),
    );
    const { manual } = await this.splitOverlay(serverId);
    const publicIp = await this.detectPublicIp();

    const address = candidates[0] || `<this machine's IP>:${port}`;
    const lines = [
      `You're invited to "${server.display_name}"!`,
      `Address: ${address}`,
      `Version: Minecraft ${mcVersion} (${flavor})`,
    ];
    if (whitelistEnforced)
      lines.push(
        'Whitelist is ON — send me your Minecraft username so I can add you.',
      );
    if (activeMods.length && !isPluginFlavor(server.type)) {
      lines.push(
        `Mods: ${activeMods.length} — grab the client modpack (.mrpack) I sent and import it into your launcher (Prism / Modrinth App).`,
      );
      if (manual.length)
        lines.push(
          `Also install these manually (not on Modrinth): ${manual.map((m) => m.name).join(', ')}.`,
        );
    }

    return {
      serverId,
      name: server.display_name,
      port,
      candidates,
      publicIp,
      publicAddress: publicIp ? `${publicIp}:${port}` : null,
      portForwardGuidance: portForwardGuidance(port),
      mcVersion,
      flavor,
      whitelistEnforced,
      modCount: activeMods.length,
      manualMods: manual.map((m) => ({ name: m.name, filename: m.filename })),
      inviteText: lines.join('\n'),
      modded: activeMods.length > 0 && !isPluginFlavor(server.type),
    };
  }

  /** Overlay rows split into mrpack-embeddable (Modrinth) vs install-manually. */
  private async splitOverlay(
    serverId: string,
  ): Promise<{ modrinth: OverlayRow[]; manual: OverlayRow[] }> {
    const allRows = await this.db
      .select({
        name: serverContent.name,
        filename: serverContent.filename,
        enabled: serverContent.enabled,
        platform: libraryFiles.platform,
        fileId: libraryFiles.fileId,
      })
      .from(serverContent)
      .leftJoin(libraryFiles, eq(libraryFiles.id, serverContent.libraryId))
      .where(
        and(
          eq(serverContent.serverId, serverId),
          eq(serverContent.managedBy, 'overlay'),
          // kind IN ('mod','plugin') filtered below — drizzle inArray would
          // also work, kept as a filter for parity with the simple legacy query
        ),
      );
    const rows = allRows.filter((r) => r.enabled);
    return {
      modrinth: rows.filter((r) => r.platform === 'modrinth' && r.fileId),
      manual: rows.filter((r) => !(r.platform === 'modrinth' && r.fileId)),
    };
  }

  // -------------------------------------------------------------------
  // .mrpack generation

  /** Concrete MC version for the pack manifest (LATEST/SNAPSHOT resolved now). */
  private async resolvedMcVersion(
    server: Pick<Server, 'mc_version'>,
  ): Promise<string> {
    if (server.mc_version !== 'LATEST' && server.mc_version !== 'SNAPSHOT')
      return server.mc_version;
    try {
      const manifest = await this.mojang.getVersionManifest();
      return server.mc_version === 'LATEST'
        ? manifest.latest.release
        : manifest.latest.snapshot;
    } catch {
      return server.mc_version; // offline — better than nothing
    }
  }

  /**
   * Build a client .mrpack into data/tmp and return { absPath, filename,
   * fileCount, manual }. Caller streams it to the user and deletes it after.
   * `host` is the address the user picked for the bundled servers.dat entry.
   */
  async generateMrpack(
    serverId: string,
    { host }: { host?: string } = {},
  ): Promise<GenerateMrpackResult> {
    const server = await this.mustGet(serverId);
    const { modrinth: embeddable, manual } = await this.splitOverlay(serverId);

    const files: {
      path: string;
      hashes: { sha1: string; sha512: string };
      env: { client: string; server: string };
      downloads: string[];
      fileSize: number;
    }[] = [];
    for (const row of embeddable) {
      let version;
      try {
        version = await this.modrinth.getVersion(row.fileId!);
      } catch {
        manual.push(row); // metadata gone from Modrinth — fall back to manual
        continue;
      }
      const file = this.modrinth.primaryFile(version);
      files.push({
        path: `mods/${file.filename}`,
        hashes: { sha1: file.hashes.sha1, sha512: file.hashes.sha512 },
        env: { client: 'required', server: 'required' },
        downloads: [file.url],
        fileSize: file.size,
      });
    }

    const dependencies: Record<string, string> = {
      minecraft: await this.resolvedMcVersion(server),
    };
    for (const [envVar, depId] of Object.entries(LOADER_ENVS)) {
      const v = server.env[envVar];
      if (v && v.toUpperCase() !== 'LATEST') dependencies[depId] = v;
    }

    const index = {
      formatVersion: 1,
      game: 'minecraft',
      versionId: `${server.display_name} 1.0`,
      name: server.display_name,
      summary: `Client pack for the "${server.display_name}" server (generated by Minecraft Server Manager)`,
      dependencies,
      files,
    };

    const address =
      host || `${localIPv4s()[0] || 'localhost'}:${server.port_game}`;
    const serversDat = this.buildServersDat({
      name: server.display_name,
      ip: address,
    });

    fs.mkdirSync(this.pathGuard.dataPath('tmp'), { recursive: true });
    const filename = `${slugify(server.display_name)}.mrpack`;
    const absPath = this.pathGuard.dataPath(
      'tmp',
      `invite-${serverId}-${Date.now()}.mrpack`,
    );

    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(absPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      out.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(out);
      archive.append(JSON.stringify(index, null, 2), {
        name: 'modrinth.index.json',
      });
      archive.append(serversDat, { name: 'overrides/servers.dat' });
      archive.finalize();
    });

    return {
      absPath,
      filename,
      fileCount: files.length,
      manual: manual.map((m) => m.name),
    };
  }

  // -------------------------------------------------------------------
  // Minimal NBT writer — servers.dat is a tiny fixed structure, so we emit
  // the bytes directly instead of pulling in an NBT dependency. Uncompressed
  // NBT: root TAG_Compound("") { TAG_List("servers") of TAG_Compound { ip, name } }.

  private nbtStr(s: unknown): Buffer {
    const bytes = Buffer.from(String(s), 'utf8');
    const len = Buffer.alloc(2);
    len.writeUInt16BE(Math.min(bytes.length, 0xffff));
    return Buffer.concat([len, bytes.subarray(0, 0xffff)]);
  }

  private namedTag(type: number, name: string, payload: Buffer): Buffer {
    return Buffer.concat([Buffer.from([type]), this.nbtStr(name), payload]);
  }

  buildServersDat({ name, ip }: { name: string; ip: string }): Buffer {
    const TAG_END = 0x00;
    const TAG_STRING = 0x08;
    const TAG_LIST = 0x09;
    const TAG_COMPOUND = 0x0a;
    // List entries are compound PAYLOADS (no type byte / name of their own).
    const entry = Buffer.concat([
      this.namedTag(TAG_STRING, 'ip', this.nbtStr(ip)),
      this.namedTag(TAG_STRING, 'name', this.nbtStr(name)),
      Buffer.from([TAG_END]),
    ]);
    const count = Buffer.alloc(4);
    count.writeInt32BE(1);
    const listPayload = Buffer.concat([
      Buffer.from([TAG_COMPOUND]),
      count,
      entry,
    ]);
    return Buffer.concat([
      Buffer.from([TAG_COMPOUND]),
      this.nbtStr(''),
      this.namedTag(TAG_LIST, 'servers', listPayload),
      Buffer.from([TAG_END]),
    ]);
  }

  portForwardGuidance(port: number): string {
    return portForwardGuidance(port);
  }
}
