import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { z, ZodError } from 'zod';
import { ServerQueryService } from '../servers/server-query.service';
import { StatsIngestService } from './stats-ingest.service';
import { StatsProfileService } from './stats-profile.service';
import { StatsXrayService } from './stats-xray.service';
import { StatsTimelineService } from './stats-timeline.service';
import { LogIngestService } from './log-ingest.service';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  try {
    return schema.parse(value);
  } catch (err) {
    if (err instanceof ZodError)
      throw new BadRequestException(
        err.issues[0]?.message || 'Invalid request',
      );
    throw err;
  }
}

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
  player: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_]{1,16}$/)
    .optional(),
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
  async timeline(@Param('id') id: string, @Query() query: unknown) {
    await this.mustServer(id);
    const q = parse(timelineSchema, query);
    return { ok: true, ...(await this.statsTimeline.timeline(id, q)) };
  }

  @Get('sessions')
  async sessions(@Param('id') id: string, @Query() query: unknown) {
    await this.mustServer(id);
    const { player } = parse(sessionsSchema, query);
    return {
      ok: true,
      sessions: await this.statsTimeline.sessionsList(id, player),
    };
  }

  @Get('scoreboard')
  async scoreboard(@Param('id') id: string, @Query() query: unknown) {
    await this.mustServer(id);
    const { metric, window } = parse(scoreboardSchema, query);
    return {
      ok: true,
      metric,
      window,
      rows: await this.statsProfile.scoreboard(id, { metric, window }),
    };
  }

  @Get('profile/:uuid')
  async profile(@Param('id') id: string, @Param('uuid') uuidParam: string) {
    await this.mustServer(id);
    const uuid = parse(
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
  async players(@Param('id') id: string) {
    await this.mustServer(id);
    return { ok: true, players: await this.statsProfile.playersList(id) };
  }

  @Get('xray')
  async xray(@Param('id') id: string) {
    await this.mustServer(id);
    return { ok: true, report: await this.statsXray.xrayReport(id) };
  }

  @Post('ingest-now')
  async ingestNow(@Param('id') id: string) {
    await this.mustServer(id);
    const backfill = await this.ingest
      .backfillFromLogs(id)
      .catch(() => ({ inserted: 0 }));
    const statResult = await this.statsIngest.ingestStats(id);
    return { ok: true, events: backfill.inserted, ...statResult };
  }
}
