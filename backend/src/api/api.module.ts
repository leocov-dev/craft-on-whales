import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import * as path from 'node:path';
import { DbModule } from '../db/db.module';
import { ConfigModule } from '../config/config.module';
import { ConfigService } from '../config/config.service';
import { EventsModule } from '../events/events.module';
import { DockerModule } from '../docker/docker.module';
import { ServersModule } from '../servers/servers.module';
import { ModsModule } from '../mods/mods.module';
import { PlayersModule } from '../players/players.module';
import { SettingsModule } from '../settings/settings.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { UpdatesModule } from '../updates/updates.module';
import { WorldsModule } from '../worlds/worlds.module';
import { PacksModule } from '../packs/packs.module';
import { AuthModule } from '../auth/auth.module';
import { TasksModule } from '../tasks/tasks.module';
import { ServerViewModelService } from './server-view-model.service';
import { ServersController } from './servers.controller';
import { DockerAdminController } from './docker-admin.controller';
import { IconsController } from './icons.controller';
import { EventsController } from './events.controller';
import { SettingsController } from './settings.controller';
import { ApiKeysController } from './api-keys.controller';
import { SchedulesController } from './schedules.controller';
import { UpdatesController } from './updates.controller';
import { BackupsController } from './backups.controller';
import { UsersController } from './users.controller';
import { PacksController } from './packs.controller';

/**
 * Cross-cutting controller module mirroring legacy `src/web/routes/api.ts`
 * (the panel's central JSON API — servers/settings/schedules/users/updates/
 * keys/events/docker/backups/packs). Appended LAST in `app.module.ts`'s
 * imports so every module it needs (Servers/Scheduler/Updates/Mods/Packs/
 * Worlds, all already tangled in their own `forwardRef()` cycle with each
 * other) is fully loaded by the time this module's imports are resolved —
 * nothing depends on ApiModule, so it adds no new cycles. See `API_NOTES.md`
 * for what's deliberately deferred (mods manager, storage, world-controls,
 * map, chat — see that file for the full list and why; icon upload has
 * since been added to `ServersController`, no longer deferred).
 */
@Module({
  imports: [
    DbModule,
    ConfigModule,
    EventsModule,
    DockerModule,
    ServersModule,
    ModsModule,
    PlayersModule,
    SettingsModule,
    ApiKeysModule,
    SchedulerModule,
    UpdatesModule,
    WorldsModule,
    PacksModule,
    AuthModule,
    TasksModule,
    // dest = <dataDir>/tmp, matching FilesModule's established pattern — same
    // filesystem as the final destination, so the icon-upload move is a
    // plain rename, not a cross-device copy.
    MulterModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        dest: path.join(config.dataDir, 'tmp'),
      }),
    }),
  ],
  controllers: [
    ServersController,
    DockerAdminController,
    IconsController,
    EventsController,
    SettingsController,
    ApiKeysController,
    SchedulesController,
    UpdatesController,
    BackupsController,
    UsersController,
    PacksController,
  ],
  providers: [ServerViewModelService],
})
export class ApiModule {}
