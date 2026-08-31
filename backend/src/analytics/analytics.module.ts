import { Module } from '@nestjs/common';
import { DockerModule } from '../docker/docker.module';
import { ServersModule } from '../servers/servers.module';
import { PathGuardModule } from '../storage/path-guard.module';
import { WorldsModule } from '../worlds/worlds.module';
import { ChatModule } from '../chat/chat.module';
import { LogClassifierService } from './log-classifier.service';
import { LogIngestService } from './log-ingest.service';
import { StatsIngestService } from './stats-ingest.service';
import { StatsProfileService } from './stats-profile.service';
import { StatsXrayService } from './stats-xray.service';
import { StatsTimelineService } from './stats-timeline.service';
import { AnalyticsController } from './analytics.controller';

@Module({
  imports: [
    DockerModule,
    ServersModule,
    PathGuardModule,
    WorldsModule,
    ChatModule,
  ],
  controllers: [AnalyticsController],
  providers: [
    LogClassifierService,
    LogIngestService,
    StatsIngestService,
    StatsProfileService,
    StatsXrayService,
    StatsTimelineService,
  ],
  exports: [
    LogClassifierService,
    LogIngestService,
    StatsIngestService,
    StatsProfileService,
    StatsXrayService,
    StatsTimelineService,
  ],
})
export class AnalyticsModule {}
