import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { TasksService } from './tasks.service';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { Task } from '../../../shared/types/tasks';
import { PermissionsService } from '../permissions/permissions.service';

/**
 * Ports `src/web/routes/tasks.ts` — poll endpoints for long-running
 * operations. Restricted to admin/operator by role (viewers never see
 * tasks at all — matches the pre-existing role gate), but an operator's
 * *default* role capability set can still be narrowed per-server, so a
 * task naming a server this operator has been explicitly hidden from is
 * filtered out here rather than left to `@Roles` alone.
 */
@Controller('api/tasks')
@UseGuards(RolesGuard)
@Roles('admin', 'operator')
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly permissions: PermissionsService,
  ) {}

  @Get()
  async list(@Req() req: Request): Promise<{ ok: true; tasks: Task[] }> {
    const all = this.tasks.listTasks();
    if (req.user?.role === 'admin') return { ok: true, tasks: all };
    const visible = await this.permissions.visibleServerIds(req.user);
    return {
      ok: true,
      tasks: all.filter((t) => !t.serverId || visible.has(t.serverId)),
    };
  }

  @Get(':id')
  async get(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<{ ok: true; task: Task }> {
    const task = this.tasks.getTask(id);
    if (!task) throw new NotFoundException('Unknown or expired task');
    if (task.serverId && req.user?.role !== 'admin') {
      const visible = await this.permissions.visibleServerIds(req.user);
      if (!visible.has(task.serverId)) {
        throw new NotFoundException('Unknown or expired task');
      }
    }
    return { ok: true, task };
  }
}
