import { Injectable } from '@nestjs/common';
import { DockerStatsService } from '../docker/docker-stats.service';
import { PermissionsService } from '../permissions/permissions.service';
import { ServerQueryService } from '../servers/server-query.service';
import type { PublicUser } from '../auth/auth.service';
import type {
  ResourceOverview,
  ServerUsage,
} from '../../../shared/types/monitoring';

/** Live CPU/memory summed across the running servers a user may see. */
@Injectable()
export class OverviewService {
  constructor(
    private readonly query: ServerQueryService,
    private readonly stats: DockerStatsService,
    private readonly permissions: PermissionsService,
  ) {}

  async forUser(user: PublicUser): Promise<ResourceOverview> {
    const visible = await this.permissions.filterVisible(
      user,
      await this.query.listServers(),
    );
    const running = visible.filter((s) => s.status === 'running');
    const samples = await Promise.all(
      running.map(async (s): Promise<ServerUsage | null> => {
        const sample = await this.stats.statsOnce(s.id).catch(() => null);
        return sample
          ? {
              id: s.id,
              name: s.display_name,
              cpuPct: sample.cpuPct,
              memUsedBytes: sample.memUsedBytes,
              memLimitBytes: sample.memLimitBytes,
            }
          : null;
      }),
    );
    const usage = samples.filter((u): u is ServerUsage => u !== null);
    const sum = (pick: (u: ServerUsage) => number) =>
      usage.reduce((acc, u) => acc + pick(u), 0);
    return {
      servers: usage,
      totals: {
        cpuPct: Math.round(sum((u) => u.cpuPct) * 10) / 10,
        memUsedBytes: sum((u) => u.memUsedBytes),
        memLimitBytes: sum((u) => u.memLimitBytes),
      },
    };
  }
}
