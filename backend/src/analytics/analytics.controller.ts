import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { parseBody } from '../utils/parse-body';
import { ServerQueryService } from '../servers/server-query.service';
import { ServerPermissionGuard } from '../permissions/server-permission.guard';
import { RequireServerPermission } from '../permissions/require-server-permission.decorator';
import { StatsIngestService } from './stats-ingest.service';
import { StatsProfileService } from './stats-profile.service';
import { StatsXrayService } from './stats-xray.service';
import { StatsTimelineService } from './stats-timeline.service';
import { LogIngestService } from './log-ingest.service';
import { playerNameSchema } from '../utils/player-name';

const timelineSchema = z.object({
  q: z.string().trim().max(200).optional(),
  type: z.string().trim().max(120).optional(),
  player: z
    .string()
    .trim()
    .regex(/^[[\]A-Za-z0-9_]{1,20}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
});

const sessionsSchema = z.object({
  player: playerNameSchema.optional(),
});

const scoreboardSchema = z.object({
  metric: z
    .enum([
      'playtimeTicks',
      'deaths',
      'mobKills',
      'playerKills',
      'blocksMinedTotal',
      'stoneMined',
      'diamondsMined',
      'ironMined',
      'ancientDebrisMined',
      'distanceCm',
      'damageDealt',
      'damageTaken',
      'jumps',
      'blocksUsedTotal',
    ])
    .default('playtimeTicks'),
  window: z.enum(['all', '7d', '24h']).default('all'),
});

/** Player analytics API. Ports `src/web/routes/analytics.ts` (mounted at /api/servers/:id/analytics). */
@Controller('api/servers/:id/analytics')
@UseGuards(ServerPermissionGuard)
export class AnalyticsController {
  constructor(
    private readonly serverQuery: ServerQueryService,
    private readonly statsIngest: StatsIngestService,
    private readonly statsProfile: StatsProfileService,
    private readonly statsXray: StatsXrayService,
    private readonly statsTimeline: StatsTimelineService,
    private readonly ingest: LogIngestService,
  ) {}

  private async mustServer(id: string): Promise<void> {
    if (!(await this.serverQuery.getServer(id)))
      throw new NotFoundException('Server not found');
  }

  @Get('timeline')
  @RequireServerPermission('view')
  async timeline(@Param('id') id: string, @Query() query: unknown) {
    await this.mustServer(id);
    const q = parseBody(timelineSchema, query);
    return { ok: true, ...(await this.statsTimeline.timeline(id, q)) };
  }

  @Get('sessions')
  @RequireServerPermission('view')
  async sessions(@Param('id') id: string, @Query() query: unknown) {
    await this.mustServer(id);
    const { player } = parseBody(sessionsSchema, query);
    return {
      ok: true,
      sessions: await this.statsTimeline.sessionsList(id, player),
    };
  }

  @Get('scoreboard')
  @RequireServerPermission('view')
  async scoreboard(@Param('id') id: string, @Query() query: unknown) {
    await this.mustServer(id);
    const { metric, window } = parseBody(scoreboardSchema, query);
    return {
      ok: true,
      metric,
      window,
      rows: await this.statsProfile.scoreboard(id, { metric, window }),
    };
  }

  @Get('profile/:uuid')
  @RequireServerPermission('view')
  async profile(@Param('id') id: string, @Param('uuid') uuidParam: string) {
    await this.mustServer(id);
    const uuid = parseBody(
      z
        .string()
        .trim()
        .regex(/^[0-9a-fA-F-]{32,36}$/),
      uuidParam,
    );
    const data = await this.statsProfile.profile(id, uuid);
    if (!data)
      throw new NotFoundException('No stats recorded for this player yet');
    return { ok: true, profile: data };
  }

  @Get('players')
  @RequireServerPermission('view')
  async players(@Param('id') id: string) {
    await this.mustServer(id);
    return { ok: true, players: await this.statsProfile.playersList(id) };
  }

  @Get('xray')
  @RequireServerPermission('view')
  async xray(@Param('id') id: string) {
    await this.mustServer(id);
    return { ok: true, report: await this.statsXray.xrayReport(id) };
  }

  @Post('ingest-now')
  @RequireServerPermission('players')
  async ingestNow(@Param('id') id: string) {
    await this.mustServer(id);
    const backfill = await this.ingest
      .backfillFromLogs(id)
      .catch(() => ({ inserted: 0 }));
    const statResult = await this.statsIngest.ingestStats(id);
    return { ok: true, events: backfill.inserted, ...statResult };
  }
}
