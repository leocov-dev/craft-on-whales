import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { DockerModule } from '../docker/docker.module';
import { McRouterService } from './mc-router.service';

@Module({
  imports: [SettingsModule, DockerModule],
  providers: [McRouterService],
  exports: [McRouterService],
})
export class McRouterModule {}
