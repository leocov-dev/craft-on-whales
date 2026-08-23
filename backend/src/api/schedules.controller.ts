import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Cron } from 'croner';
import { z, ZodError } from 'zod';
import { SchedulerService, TASK_TYPES } from '../scheduler/scheduler.service';
import { SettingsService } from '../settings/settings.service';
import type { ScheduleViewModel, TaskTypeOption } from '../../../shared/types/schedules';

function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  try {
    return schema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) throw new BadRequestException(err.issues[0]?.message || 'Invalid request');
    throw err;
  }
}

/** Ports the "Schedules" section of legacy `src/web/routes/api.ts`. */
@Controller('api/schedules')
export class SchedulesController {
  constructor(
    private readonly scheduler: SchedulerService,
    private readonly settings: SettingsService
  ) {}

  @Get('preview')
  preview(@Req() req: Request) {
    const expr = String(req.query.cron || '').trim();
    try {
      if (!expr) throw new Error('Empty expression');
      const runs = new Cron(expr, { timezone: this.settings.getTimezone() }).nextRuns(3).map((d: Date) => d.toISOString());
      return { ok: true, cron: expr, runs };
    } catch (err) {
      return { ok: false, error: `Invalid cron expression: ${(err as Error).message}` };
    }
  }

  @Get()
  list(): { ok: true; schedules: ScheduleViewModel[]; taskTypes: TaskTypeOption[] } {
    return {
      ok: true,
      schedules: this.scheduler.listSchedules(),
      taskTypes: Object.entries(TASK_TYPES).map(([value, t]) => ({ value, label: t.label, serverScoped: t.serverScoped })),
    };
  }

  @Post()
  create(@Req() req: Request, @Body() body: unknown): { ok: true; schedule: ScheduleViewModel | undefined } {
    const input = parseBody(
      z.object({
        serverId: z.string().trim().max(40).nullable().optional(),
        taskType: z.string().trim().min(2).max(30),
        cron: z.string().trim().min(5).max(60),
        payload: z.record(z.string(), z.any()).optional(),
        enabled: z.coerce.boolean().optional(),
      }),
      body
    );
    const schedule = this.scheduler.createSchedule(
      { serverId: input.serverId || null, taskType: input.taskType, cron: input.cron, payload: input.payload, enabled: input.enabled !== false },
      { actor: req.user!.username }
    );
    return { ok: true, schedule };
  }

  @Post(':id/toggle')
  toggle(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const { enabled } = parseBody(z.object({ enabled: z.boolean() }), body);
    this.scheduler.setEnabled(id, enabled, { actor: req.user!.username });
    return { ok: true };
  }

  @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string) {
    this.scheduler.deleteSchedule(id, { actor: req.user!.username });
    return { ok: true };
  }
}
