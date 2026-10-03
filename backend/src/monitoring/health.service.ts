import { Injectable } from '@nestjs/common';
import { ContainerService } from '../docker/container.service';
import { EventsService } from '../events/events.service';
import { CrashesService } from '../crashes/crashes.service';
import type { ServerHealth } from '../../../shared/types/monitoring';

const WINDOW_DAYS = 7;

/** Stability facts already recorded elsewhere, gathered for one server. */
@Injectable()
export class HealthService {
  constructor(
    private readonly containers: ContainerService,
    private readonly events: EventsService,
    private readonly crashes: CrashesService,
  ) {}

  async forServer(serverId: string): Promise<ServerHealth> {
    const [info, counts, lastCrashEvents, reports] = await Promise.all([
      this.containers.inspectStatus(serverId),
      this.events.countByType(
        serverId,
        ['crashed', 'oom', 'crash-loop', 'startup-stalled'],
        WINDOW_DAYS,
      ),
      this.events.listEvents({ serverId, type: 'crashed', limit: 1 }),
      this.crashes.listCrashes(serverId),
    ]);
    const lastEvent = lastCrashEvents[0];
    const report = reports[0];
    return {
      status: info.status,
      health: info.exists ? (info.health ?? null) : null,
      exitCode: info.exists ? (info.exitCode ?? null) : null,
      oomKilled: info.exists ? Boolean(info.oomKilled) : false,
      startedAt: info.exists ? (info.startedAt ?? null) : null,
      windowDays: WINDOW_DAYS,
      crashes: counts['crashed'] ?? 0,
      oomKills: counts['oom'] ?? 0,
      crashLoops: counts['crash-loop'] ?? 0,
      stalledStarts: counts['startup-stalled'] ?? 0,
      lastCrash: lastEvent
        ? { at: lastEvent.createdAt, summary: lastEvent.summary }
        : null,
      lastCrashReport: report
        ? { id: report.id, filename: report.filename, summary: report.summary }
        : null,
    };
  }
}
