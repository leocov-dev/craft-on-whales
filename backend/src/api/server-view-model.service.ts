import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { ContainerService } from '../docker/container.service';
import { DockerStatsService } from '../docker/docker-stats.service';
import { MojangService } from '../players/mojang.service';
import { ModsService } from '../mods/mods.service';
import { PlayerRosterService } from '../players/player-roster.service';
import { crashReports, serverPacks, storageIndex, updateChecks } from '../db/schema';
import { displayVersion, flavorLabel } from '../integrations/view-labels.util';
import type { Server } from '../servers/types';
import type { PackViewModel, ServerViewModel, ServerStatus } from '../../../shared/types/servers';

export type { PackViewModel, ServerViewModel };

const GB = 1024 ** 3;

const PLATFORM_NAMES: Record<string, string> = { curseforge: 'CurseForge', modrinth: 'Modrinth', ftb: 'FTB' };

/**
 * Ports `src/web/viewModels.ts`'s `serverVM`/`packVM` — the exact JSON shape
 * the already-built Vue frontend expects.
 *
 * Scoped simplification vs. legacy: live stats/players/boot-phase come from
 * a per-request `DockerStatsService.statsOnce`/`ContainerService.inspectStatus`/
 * `PlayerRosterService.listOnlineNames` lookup instead of legacy's persistent
 * `liveCache` watcher (a stats-stream + polling cache kept warm across
 * requests). Same final JSON shape; the boot-phase `statusDetail` classifier
 * and the always-warm cache are NOT ported here — that infra belongs with
 * the future WS gateway work (`ConsoleGateway`/`StatsGateway`), which needs
 * the exact same live-stats plumbing anyway. Until then, `statusDetail` is
 * always omitted and stats/players are fetched fresh per request (a few
 * hundred ms of extra latency on a running server's detail view, not the
 * free in-memory read legacy had).
 */
@Injectable()
export class ServerViewModelService {
  constructor(
    private readonly dbService: DbService,
    private readonly mojang: MojangService,
    private readonly mods: ModsService,
    private readonly containers: ContainerService,
    private readonly stats: DockerStatsService,
    private readonly playerRoster: PlayerRosterService
  ) {}

  private get db() {
    return this.dbService.db;
  }

  async serverVM(s: Server, { withLive = true }: { withLive?: boolean } = {}): Promise<ServerViewModel> {
    const vm: ServerViewModel = {
      id: s.id,
      name: s.display_name,
      description: s.description,
      icon: s.icon,
      accent: s.accent,
      tags: s.tags,
      type: s.type,
      flavor: flavorLabel(s.type),
      loader: this.mods.loaderOf(s),
      mcVersion: await displayVersion(this.mojang, s.mc_version),
      javaTag: s.java_tag || 'auto',
      // servers.status is a plain `text` column (no DB-level CHECK, matching
      // this schema's general approach — see DRIZZLE_NOTES.md), so the cast
      // trusts that only ServerStatus's known values are ever written there.
      status: s.status as ServerStatus,
      ports: { game: s.port_game, rcon: s.port_rcon, bedrock: s.port_bedrock },
      resources: { heapMb: s.heap_mb, containerMemoryMb: s.container_memory_mb, cpus: s.cpus },
      stats: { cpuPct: 0, memUsedMb: 0, uptime: null },
      players: { online: 0, max: Number(s.env.MAX_PLAYERS) || 20, names: [] },
      disk: { used: await this.diskUsed(s.id), quota: s.disk_quota_bytes || 25 * GB },
      pack: await this.packVM(s.id),
      updateAvailable: await this.hasPackUpdate(s.id),
      crashesUnread: await this.crashesUnread(s.id),
      autoStart: Boolean(s.auto_start),
      autoRestart: Boolean(s.auto_restart),
      notes: s.notes,
      updatePolicy: s.update_policy,
      pendingRecreate: Boolean(s.pending_recreate),
      lastStarted: s.last_started_at || '—',
      created: s.created_at,
      consoleLabel: s.console_label || '',
    };

    if (withLive && (s.status === 'running' || s.status === 'starting' || s.status === 'unhealthy')) {
      const [sample, onlineNames] = await Promise.all([
        this.stats.statsOnce(s.id).catch(() => null),
        this.playerRoster.listOnlineNames(s.id).catch(() => [] as string[]),
      ]);
      if (sample) {
        vm.stats.cpuPct = sample.cpuPct;
        vm.stats.memUsedMb = Math.round(sample.memUsedBytes / 1024 / 1024);
      }
      const info = await this.containers.inspectStatus(s.id).catch(() => null);
      if (info?.startedAt) vm.stats.uptime = formatUptime(Date.now() - Date.parse(info.startedAt));
      if (onlineNames.length) vm.players = { ...vm.players, online: onlineNames.length, names: onlineNames };
    }
    return vm;
  }

  private async getPackUpdateCheck(serverId: string) {
    const [row] = await this.db
      .select({ latestVersion: updateChecks.latestVersion, latestName: updateChecks.latestName })
      .from(updateChecks)
      .where(and(eq(updateChecks.subjectType, 'pack'), eq(updateChecks.subjectId, serverId)))
      .limit(1);
    return row;
  }

  async packVM(serverId: string): Promise<PackViewModel | null> {
    const [pack] = await this.db.select().from(serverPacks).where(eq(serverPacks.serverId, serverId)).limit(1);
    if (!pack) return null;
    const check = await this.getPackUpdateCheck(serverId);
    const platformName = PLATFORM_NAMES[pack.platform];
    return {
      platform: platformName || pack.platform,
      name: pack.projectName,
      version: pack.pinnedVersionName,
      versionId: pack.pinnedVersionId,
      latest: check?.latestName || pack.pinnedVersionName,
      latestVersionId: check?.latestVersion || null,
    };
  }

  private async hasPackUpdate(serverId: string): Promise<boolean> {
    const [pack] = await this.db
      .select({ pinnedVersionId: serverPacks.pinnedVersionId })
      .from(serverPacks)
      .where(eq(serverPacks.serverId, serverId))
      .limit(1);
    if (!pack) return false;
    const check = await this.getPackUpdateCheck(serverId);
    return Boolean(check?.latestVersion && check.latestVersion !== pack.pinnedVersionId);
  }

  private async diskUsed(serverId: string): Promise<number> {
    const [row] = await this.db
      .select({ sizeBytes: storageIndex.sizeBytes })
      .from(storageIndex)
      .where(eq(storageIndex.relPath, `servers/${serverId}`))
      .limit(1);
    return row ? row.sizeBytes : 0;
  }

  private async crashesUnread(serverId: string): Promise<number> {
    const rows = await this.db
      .select({ viewed: crashReports.viewed })
      .from(crashReports)
      .where(eq(crashReports.serverId, serverId));
    return rows.filter((r) => !r.viewed).length;
  }
}

function formatUptime(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
