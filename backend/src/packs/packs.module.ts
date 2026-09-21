import { forwardRef, Module } from '@nestjs/common';
import { ServersModule } from '../servers/servers.module';
import { ModsModule } from '../mods/mods.module';
import { PathGuardModule } from '../storage/path-guard.module';
import { WorldsModule } from '../worlds/worlds.module';
import { PacksService } from './packs.service';
import { PackPinSweepService } from './pack-pin-sweep.service';

// forwardRef: PacksModule sits on the ServersModule -> SchedulerModule ->
// UpdatesModule -> PacksModule -> ServersModule cycle created once
// SchedulerModule (forwardRef'd from ServersModule) pulled UpdatesModule in.
@Module({
  imports: [
    forwardRef(() => ServersModule),
    ModsModule,
    PathGuardModule,
    WorldsModule,
  ],
  // PackPinSweepService runs its boot sweep from OnModuleInit — registered
  // here (not ServersModule) since it needs `server_packs`, which is this
  // module's concern; ServersModule -> PacksModule would be the reverse of
  // the forwardRef above and isn't needed (PackPinGuardService, the piece
  // ServerLifecycleService needs, lives in servers/ instead — see its NOTES).
  providers: [PacksService, PackPinSweepService],
  exports: [PacksService],
})
export class PacksModule {}
