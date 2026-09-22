import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Cron } from 'croner';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { parseBody } from '../utils/parse-body';
import { SchedulerService, TASK_TYPES } from '../scheduler/scheduler.service';
import { SettingsService } from '../settings/settings.service';
import type {
  ScheduleViewModel,
  TaskTypeOption,
} from '../../../shared/types/schedules';
import { currentUser } from '../auth/current-user';
import type { DbService } from '../db/db.service';
import { schedules } from '../db/schema';
import { ServerPermissionGuard } from '../permissions/server-permission.guard';
import { RequireServerPermission } from '../permissions/require-server-permission.decorator';
import { PermissionsService } from '../permissions/permissions.service';

/** `serverId` from the create body — `null`/absent means a panel-wide schedule. */
function serverIdFromBody(req: { body?: unknown }): string | null {
  const body = req.body as { serverId?: unknown } | undefined;
  return typeof body?.serverId === 'string' ? body.serverId : null;
}

/** The server a schedule targets, for the `:id/toggle` and `:id` routes. */
async function scheduleServerId(
  req: Request,
  { db }: { db: DbService },
): Promise<string | null> {
  const id = req.params?.id;
  if (typeof id !== 'string') return null;
  const [row] = await db.db
    .select({ serverId: schedules.serverId })
    .from(schedules)
    .where(eq(schedules.id, id))
    .limit(1);
  return row?.serverId ?? null;
}

/** Ports the "Schedules" section of legacy `src/web/routes/api.ts`. */
@Controller('api/schedules')
export class SchedulesController {
  constructor(
    private readonly scheduler: SchedulerService,
    private readonly settings: SettingsService,
    private readonly permissions: PermissionsService,
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
  async list(@Req() req: Request): Promise<{
    ok: true;
    schedules: ScheduleViewModel[];
    taskTypes: TaskTypeOption[];
  }> {
    const all = await this.scheduler.listSchedules();
    // A schedule naming a server the caller can't view is hidden the same
    // way that server is everywhere else — panel-wide schedules
    // (serverId null) are unaffected.
    const visibleIds = await this.permissions.visibleServerIds(req.user);
    const visible =
      req.user?.role === 'admin'
        ? all
        : all.filter((s) => !s.serverId || visibleIds.has(s.serverId));
    return {
      ok: true,
      schedules: visible,
      taskTypes: Object.entries(TASK_TYPES).map(([value, t]) => ({
        value,
        label: t.label,
        serverScoped: t.serverScoped,
      })),
    };
  }

  @Post()
  @UseGuards(ServerPermissionGuard)
  @RequireServerPermission('power', serverIdFromBody)
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
      { actor: currentUser(req).username },
    );
    return { ok: true, schedule };
  }

  @Post(':id/toggle')
  @UseGuards(ServerPermissionGuard)
  @RequireServerPermission('power', scheduleServerId)
  async toggle(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { enabled } = parseBody(z.object({ enabled: z.boolean() }), body);
    await this.scheduler.setEnabled(id, enabled, {
      actor: currentUser(req).username,
    });
    return { ok: true };
  }

  @Delete(':id')
  @UseGuards(ServerPermissionGuard)
  @RequireServerPermission('power', scheduleServerId)
  async remove(@Req() req: Request, @Param('id') id: string) {
    await this.scheduler.deleteSchedule(id, {
      actor: currentUser(req).username,
    });
    return { ok: true };
  }
}
