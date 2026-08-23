import { Module } from '@nestjs/common';
import { DockerModule } from '../docker/docker.module';
import { PathGuardModule } from '../storage/path-guard.module';
import { ServersModule } from '../servers/servers.module';
import { WorldControlsService } from './world-controls.service';
import { WorldControlsController } from './world-controls.controller';

@Module({
  imports: [DockerModule, PathGuardModule, ServersModule],
  controllers: [WorldControlsController],
  providers: [WorldControlsService],
  exports: [WorldControlsService],
})
export class WorldControlsModule {}
