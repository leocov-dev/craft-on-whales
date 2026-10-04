import { Module } from '@nestjs/common';
import { MaintenanceService } from './maintenance.service';
import { PanelDbService } from './panel-db.service';
import { RetentionService } from './retention.service';

// DbService, EventsService and PathGuardService come from @Global modules.
// Deliberately imports nothing else: SchedulerModule depends on this module,
// and pulling in AnalyticsModule (-> ServersModule -> SchedulerModule) would
// close a module cycle. That is why analytics pruning lives here, not there.
@Module({
  providers: [MaintenanceService, PanelDbService, RetentionService],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
