import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { StatusService } from './status.service';
import { ServerQueryService } from '../servers/server-query.service';
import { ContainerService } from '../docker/container.service';
import { PlayerRosterService } from '../players/player-roster.service';
import type { StatusPageData } from '../../../shared/types/status';

function formatUptime(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * PUBLIC status page JSON endpoint (MP9). Ports the `/status/api/:slug`
 * branch of `src/web/routes/status.ts` — the Handlebars `/status/:slug`
 * page-render branch has no equivalent now that the Vue frontend owns
 * rendering. `@Public()` — must stay safe for open-internet traffic, so
 * live stats are a single cheap per-request lookup, never a Docker command
 * that could be used to hammer the daemon.
 */
@Controller('status/api')
export class StatusController {
  constructor(
    private readonly status: StatusService,
    private readonly serverQuery: ServerQueryService,
    private readonly containers: ContainerService,
    private readonly playerRoster: PlayerRosterService,
  ) {}

  @Public()
  @Get(':slug')
  async getPage(@Param('slug') slug: string) {
    const page = await this.loadPage(slug);
    if (!page) throw new NotFoundException('Not found');
    return { ok: true, page };
  }

  private async loadPage(slug: string): Promise<StatusPageData | null> {
    const serverId = await this.status.findBySlug(slug);
    const row = serverId ? await this.serverQuery.getServer(serverId) : null;
    if (!row) return null;

    let online = 0;
    let uptime: string | null = null;
    if (
      row.status === 'running' ||
      row.status === 'starting' ||
      row.status === 'unhealthy'
    ) {
      const [onlineNames, info] = await Promise.all([
        this.playerRoster.listOnlineNames(row.id).catch(() => [] as string[]),
        this.containers.inspectStatus(row.id).catch(() => null),
      ]);
      online = onlineNames.length;
      if (info?.startedAt)
        uptime = formatUptime(Date.now() - Date.parse(info.startedAt));
    }

    return {
      name: row.display_name,
      icon: row.icon,
      accent: row.accent,
      motd: (row.env.MOTD || '').replace(/[§&][0-9a-fk-or]/gi, ''),
      flavor: row.type,
      mcVersion: row.mc_version,
      status: row.status,
      online,
      max: Number(row.env.MAX_PLAYERS) || 20,
      uptime,
    };
  }
}
