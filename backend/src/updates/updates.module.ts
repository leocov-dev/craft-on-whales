import { forwardRef, Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { ServersModule } from '../servers/servers.module';
import { PacksModule } from '../packs/packs.module';
import { ModsModule } from '../mods/mods.module';
import { WorldsModule } from '../worlds/worlds.module';
import { DockerModule } from '../docker/docker.module';
import { UpdateCheckerService } from './update-checker.service';
import { UpdateUpgradeService } from './update-upgrade.service';

// forwardRef: closes a genuine module-level cycle — ServersModule
// forwardRef()s SchedulerModule, SchedulerModule plainly imports
// UpdatesModule, and UpdatesModule needs ServersModule back. Without this,
// requiring ServersModule here mid-load (while it's still evaluating its own
// SchedulerModule import) returns an undefined export.
@Module({
  imports: [EventsModule, forwardRef(() => ServersModule), PacksModule, ModsModule, WorldsModule, DockerModule],
  providers: [UpdateCheckerService, UpdateUpgradeService],
  exports: [UpdateCheckerService, UpdateUpgradeService],
})
export class UpdatesModule {}
