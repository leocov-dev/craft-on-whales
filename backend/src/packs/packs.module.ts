import { forwardRef, Module } from '@nestjs/common';
import { ServersModule } from '../servers/servers.module';
import { ModsModule } from '../mods/mods.module';
import { PathGuardModule } from '../storage/path-guard.module';
import { WorldsModule } from '../worlds/worlds.module';
import { PacksService } from './packs.service';

// forwardRef: PacksModule sits on the ServersModule -> SchedulerModule ->
// UpdatesModule -> PacksModule -> ServersModule cycle created once
// SchedulerModule (forwardRef'd from ServersModule) pulled UpdatesModule in.
@Module({
  imports: [forwardRef(() => ServersModule), ModsModule, PathGuardModule, WorldsModule],
  providers: [PacksService],
  exports: [PacksService],
})
export class PacksModule {}
