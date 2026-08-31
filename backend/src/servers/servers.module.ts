import { forwardRef, Module } from '@nestjs/common';
import { DockerModule } from '../docker/docker.module';
import { AuthModule } from '../auth/auth.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { SettingsModule } from '../settings/settings.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { MapModule } from '../map/map.module';
import { MapService } from '../map/map.service';
import { JavaMatrixService } from './java-matrix.service';
import { PortsService } from './ports.service';
import { DockerSpecService } from './docker-spec.service';
import { ServerQueryService } from './server-query.service';
import { ServerEnvironmentService } from './server-environment.service';
import { ServerPreviewService } from './server-preview.service';
import { ServerLocksService } from './server-locks.service';
import { ServerLifecycleService } from './server-lifecycle.service';
import { MAP_SERVICE_CONTRACT } from './map-service.contract';
import { SCHEDULER_CONTRACT } from './scheduler.contract';
import { SchedulerService } from '../scheduler/scheduler.service';

@Module({
  imports: [
    DockerModule,
    AuthModule,
    ApiKeysModule,
    SettingsModule,
    forwardRef(() => SchedulerModule),
    forwardRef(() => MapModule),
  ],
  providers: [
    JavaMatrixService,
    PortsService,
    DockerSpecService,
    ServerQueryService,
    ServerEnvironmentService,
    ServerPreviewService,
    ServerLocksService,
    ServerLifecycleService,
    { provide: MAP_SERVICE_CONTRACT, useExisting: MapService },
    { provide: SCHEDULER_CONTRACT, useExisting: SchedulerService },
  ],
  exports: [
    JavaMatrixService,
    PortsService,
    DockerSpecService,
    ServerQueryService,
    ServerEnvironmentService,
    ServerPreviewService,
    ServerLocksService,
    ServerLifecycleService,
  ],
})
export class ServersModule {}
