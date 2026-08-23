import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { DockerModule } from '../docker/docker.module';
import { McRouterService } from './mc-router.service';
import { McRouterController } from './mc-router.controller';

@Module({
  imports: [SettingsModule, DockerModule],
  controllers: [McRouterController],
  providers: [McRouterService],
  exports: [McRouterService],
})
export class McRouterModule {}
