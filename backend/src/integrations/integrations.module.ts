import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PathGuardModule } from '../storage/path-guard.module';
import { ServersModule } from '../servers/servers.module';
import { ModsModule } from '../mods/mods.module';
import { PlayersModule } from '../players/players.module';
import { StatusModule } from '../status/status.module';
import { EventsModule } from '../events/events.module';
import { DiscordService } from './discord.service';
import { InvitesService } from './invites.service';
import { IntegrationsController } from './integrations.controller';
import { RestartHookController } from './restart-hook.controller';
import { RestartHookGuard } from './restart-hook.guard';
import { RestartHookService } from './restart-hook.service';

@Module({
  imports: [
    AuthModule,
    PathGuardModule,
    ServersModule,
    ModsModule,
    PlayersModule,
    StatusModule,
    EventsModule,
  ],
  controllers: [IntegrationsController, RestartHookController],
  providers: [
    DiscordService,
    InvitesService,
    RestartHookService,
    RestartHookGuard,
  ],
  exports: [DiscordService, InvitesService],
})
export class IntegrationsModule {}
