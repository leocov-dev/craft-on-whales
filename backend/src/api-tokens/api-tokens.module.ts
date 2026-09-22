import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { EventsModule } from '../events/events.module';
import { SettingsModule } from '../settings/settings.module';
import { ServersModule } from '../servers/servers.module';
import { ApiTokensService } from './api-tokens.service';
import { ApiRateLimitService } from './api-rate-limit.service';
import { BearerAuthGuard } from './bearer-auth.guard';
import { ApiTokensController } from './api-tokens.controller';
import { PublicApiController } from './public-api.controller';

@Module({
  imports: [DbModule, EventsModule, SettingsModule, ServersModule],
  controllers: [ApiTokensController, PublicApiController],
  providers: [ApiTokensService, ApiRateLimitService, BearerAuthGuard],
  exports: [ApiTokensService],
})
export class ApiTokensModule {}
