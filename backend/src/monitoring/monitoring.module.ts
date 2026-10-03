import { Module } from '@nestjs/common';
import { DockerModule } from '../docker/docker.module';
import { EventsModule } from '../events/events.module';
import { CrashesModule } from '../crashes/crashes.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { ServersModule } from '../servers/servers.module';
import { TpsService } from './tps.service';
import { HealthService } from './health.service';
import { OverviewService } from './overview.service';
import {
  MonitoringController,
  MonitoringOverviewController,
} from './monitoring.controller';

@Module({
  imports: [
    DockerModule,
    EventsModule,
    CrashesModule,
    PermissionsModule,
    ServersModule,
  ],
  controllers: [MonitoringController, MonitoringOverviewController],
  providers: [TpsService, HealthService, OverviewService],
  exports: [TpsService],
})
export class MonitoringModule {}
