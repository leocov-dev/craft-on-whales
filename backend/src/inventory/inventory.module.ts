import { forwardRef, Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { DockerModule } from '../docker/docker.module';
import { ServersModule } from '../servers/servers.module';
import { WorldsModule } from '../worlds/worlds.module';
import { PathGuardModule } from '../storage/path-guard.module';
import { PlayersModule } from '../players/players.module';
import { ItemsModule } from '../items/items.module';
import { InventoryService } from './inventory.service';
import { PlayerDataFileService } from './player-data-file.service';
import { ItemSearchService } from './item-search.service';
import { InventorySnapshotService } from './inventory-snapshot.service';
import { InventoryWatcherService } from './inventory-watcher.service';
import { InventoryEditService } from './inventory-edit.service';
import {
  InventoryController,
  InventoryGlobalController,
} from './inventory.controller';

@Module({
  imports: [
    DbModule,
    DockerModule,
    ServersModule,
    WorldsModule,
    PathGuardModule,
    forwardRef(() => PlayersModule),
    ItemsModule,
  ],
  controllers: [InventoryController, InventoryGlobalController],
  providers: [
    PlayerDataFileService,
    ItemSearchService,
    InventorySnapshotService,
    InventoryWatcherService,
    InventoryEditService,
    InventoryService,
  ],
  exports: [
    PlayerDataFileService,
    ItemSearchService,
    InventorySnapshotService,
    InventoryWatcherService,
    InventoryEditService,
    InventoryService,
  ],
})
export class InventoryModule {}
