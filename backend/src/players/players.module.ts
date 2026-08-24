import { forwardRef, Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { EventsModule } from '../events/events.module';
import { DockerModule } from '../docker/docker.module';
import { PathGuardModule } from '../storage/path-guard.module';
import { InventoryModule } from '../inventory/inventory.module';
import { MojangService } from './mojang.service';
import { MojangProfilesService } from './mojang-profiles.service';
import { PlayerRosterService } from './player-roster.service';
import { PlayerTeleportService } from './player-teleport.service';
import { PlayersController } from './players.controller';
import { ServersModule } from '../servers/servers.module';

@Module({
  imports: [
    DbModule,
    EventsModule,
    DockerModule,
    PathGuardModule,
    forwardRef(() => InventoryModule),
    ServersModule,
  ],
  controllers: [PlayersController],
  providers: [
    MojangService,
    MojangProfilesService,
    PlayerRosterService,
    PlayerTeleportService,
  ],
  exports: [
    MojangService,
    MojangProfilesService,
    PlayerRosterService,
    PlayerTeleportService,
  ],
})
export class PlayersModule {}
