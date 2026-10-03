import { forwardRef, Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { SettingsModule } from '../settings/settings.module';
import { DockerModule } from '../docker/docker.module';
import { StorageIndexModule } from '../storage/storage-index.module';
import { PathGuardModule } from '../storage/path-guard.module';
import { AuthModule } from '../auth/auth.module';
import { WorldsModule } from '../worlds/worlds.module';
import { ServersModule } from '../servers/servers.module';
import { UpdatesModule } from '../updates/updates.module';
import { MaintenanceModule } from '../maintenance/maintenance.module';
import { SchedulerService } from './scheduler.service';

@Module({
  imports: [
    EventsModule,
    SettingsModule,
    DockerModule,
    StorageIndexModule,
    PathGuardModule,
    AuthModule,
    WorldsModule,
    UpdatesModule,
    MaintenanceModule,
    forwardRef(() => ServersModule),
  ],
  providers: [SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
