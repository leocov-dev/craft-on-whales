import { forwardRef, Module } from '@nestjs/common';
import { DockerModule } from '../docker/docker.module';
import { AuthModule } from '../auth/auth.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { SettingsModule } from '../settings/settings.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { MapModule } from '../map/map.module';
import { JavaMatrixService } from './java-matrix.service';
import { PortsService } from './ports.service';
import { DockerSpecService } from './docker-spec.service';
import { ServerQueryService } from './server-query.service';
import { ServerEnvironmentService } from './server-environment.service';
import { ServerPreviewService } from './server-preview.service';
import { ServerLocksService } from './server-locks.service';
import { ServerLifecycleService } from './server-lifecycle.service';

@Module({
  imports: [DockerModule, AuthModule, ApiKeysModule, SettingsModule, forwardRef(() => SchedulerModule), forwardRef(() => MapModule)],
  providers: [
    JavaMatrixService,
    PortsService,
    DockerSpecService,
    ServerQueryService,
    ServerEnvironmentService,
    ServerPreviewService,
    ServerLocksService,
    ServerLifecycleService,
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
