import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Cron } from 'croner';
import { z } from 'zod';
import { parseBody } from '../utils/parse-body';
import { SchedulerService, TASK_TYPES } from '../scheduler/scheduler.service';
import { SettingsService } from '../settings/settings.service';
import type {
  ScheduleViewModel,
  TaskTypeOption,
} from '../../../shared/types/schedules';

/** Ports the "Schedules" section of legacy `src/web/routes/api.ts`. */
@Controller('api/schedules')
export class SchedulesController {
  constructor(
    private readonly scheduler: SchedulerService,
    private readonly settings: SettingsService,
  ) {}

  @Get('preview')
  async preview(@Req() req: Request) {
    const expr = (
      typeof req.query.cron === 'string' ? req.query.cron : ''
    ).trim();
    try {
      if (!expr) throw new Error('Empty expression');
      const runs = new Cron(expr, {
        timezone: await this.settings.getTimezone(),
      })
        .nextRuns(3)
        .map((d: Date) => d.toISOString());
      return { ok: true, cron: expr, runs };
    } catch (err) {
      return {
        ok: false,
        error: `Invalid cron expression: ${(err as Error).message}`,
      };
    }
  }

  @Get()
  async list(): Promise<{
    ok: true;
    schedules: ScheduleViewModel[];
    taskTypes: TaskTypeOption[];
  }> {
    return {
      ok: true,
      schedules: await this.scheduler.listSchedules(),
      taskTypes: Object.entries(TASK_TYPES).map(([value, t]) => ({
        value,
        label: t.label,
        serverScoped: t.serverScoped,
      })),
    };
  }

  @Post()
  async create(
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<{ ok: true; schedule: ScheduleViewModel | undefined }> {
    const input = parseBody(
      z.object({
        serverId: z.string().trim().max(40).nullable().optional(),
        taskType: z.string().trim().min(2).max(30),
        cron: z.string().trim().min(5).max(60),
        payload: z.record(z.string(), z.any()).optional(),
        enabled: z.coerce.boolean().optional(),
      }),
      body,
    );
    const schedule = await this.scheduler.createSchedule(
      {
        serverId: input.serverId || null,
        taskType: input.taskType,
        cron: input.cron,
        payload: input.payload,
        enabled: input.enabled !== false,
      },
      { actor: req.user!.username },
    );
    return { ok: true, schedule };
  }

  @Post(':id/toggle')
  async toggle(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { enabled } = parseBody(z.object({ enabled: z.boolean() }), body);
    await this.scheduler.setEnabled(id, enabled, { actor: req.user!.username });
    return { ok: true };
  }

  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string) {
    await this.scheduler.deleteSchedule(id, { actor: req.user!.username });
    return { ok: true };
  }
}
