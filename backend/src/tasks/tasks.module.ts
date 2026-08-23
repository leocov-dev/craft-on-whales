import { Global, Module } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';

// @Global: every long-running service (BackupsService, UpdateUpgradeService,
// future pack/blueprint import flows) can create/report through a task
// handle without each importing module needing to wire TasksModule in.
@Global()
@Module({
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
