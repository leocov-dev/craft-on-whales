import {
  Controller,
  Get,
  NotFoundException,
  Param,
  UseGuards,
} from '@nestjs/common';
import { TasksService } from './tasks.service';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { Task } from '../../../shared/types/tasks';

/** Ports `src/web/routes/tasks.ts` — poll endpoints for long-running operations. */
@Controller('api/tasks')
@UseGuards(RolesGuard)
@Roles('admin', 'operator')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  list(): { ok: true; tasks: Task[] } {
    return { ok: true, tasks: this.tasks.listTasks() };
  }

  @Get(':id')
  get(@Param('id') id: string): { ok: true; task: Task } {
    const task = this.tasks.getTask(id);
    if (!task) throw new NotFoundException('Unknown or expired task');
    return { ok: true, task };
  }
}
