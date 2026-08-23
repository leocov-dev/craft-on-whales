import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ServersModule } from '../servers/servers.module';
import { DockerModule } from '../docker/docker.module';
import { EventsModule } from '../events/events.module';
import { ConsoleGateway } from './console.gateway';
import { StatsGateway } from './stats.gateway';

@Module({
  imports: [AuthModule, ServersModule, DockerModule, EventsModule],
  providers: [ConsoleGateway, StatsGateway],
})
export class WsModule {}
