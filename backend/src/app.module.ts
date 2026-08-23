import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { EventsModule } from './events/events.module';
import { DockerModule } from './docker/docker.module';
import { AuthModule } from './auth/auth.module';
import { PathGuardModule } from './storage/path-guard.module';
import { ApiKeysModule } from './api-keys/api-keys.module';
import { SettingsModule } from './settings/settings.module';
import { ServersModule } from './servers/servers.module';
import { StorageIndexModule } from './storage/storage-index.module';
import { LibraryModule } from './library/library.module';
import { WorldsModule } from './worlds/worlds.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { CrashesModule } from './crashes/crashes.module';
import { ItemsModule } from './items/items.module';
import { McRouterModule } from './mc-router/mc-router.module';
import { StatusModule } from './status/status.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { ModsModule } from './mods/mods.module';
import { InventoryModule } from './inventory/inventory.module';
import { PlayersModule } from './players/players.module';
import { PacksModule } from './packs/packs.module';
import { SolverModule } from './solver/solver.module';
import { ChatModule } from './chat/chat.module';
import { UpdatesModule } from './updates/updates.module';
import { BlueprintsModule } from './blueprints/blueprints.module';
import { MapModule } from './map/map.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { TasksModule } from './tasks/tasks.module';
import { WorldControlsModule } from './world-controls/world-controls.module';
import { ApiModule } from './api/api.module';
import { FilesModule } from './files/files.module';
import { WsModule } from './ws/ws.module';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [
    ConfigModule,
    DbModule,
    EventsModule,
    DockerModule,
    AuthModule,
    PathGuardModule,
    ApiKeysModule,
    SettingsModule,
    ServersModule,
    StorageIndexModule,
    LibraryModule,
    WorldsModule,
    SchedulerModule,
    CrashesModule,
    ItemsModule,
    McRouterModule,
    StatusModule,
    AnalyticsModule,
    ModsModule,
    InventoryModule,
    PlayersModule,
    PacksModule,
    SolverModule,
    ChatModule,
    UpdatesModule,
    BlueprintsModule,
    MapModule,
    IntegrationsModule,
    TasksModule,
    WorldControlsModule,
    ApiModule,
    FilesModule,
    WsModule,
    StorageModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
