import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ServersModule } from '../servers/servers.module';
import { DockerModule } from '../docker/docker.module';
import { EventsModule } from '../events/events.module';
import { StatusBusModule } from '../status-bus/status-bus.module';
import { ConsoleGateway } from './console.gateway';
import { StatsGateway } from './stats.gateway';
import { StatusGateway } from './status.gateway';

@Module({
  imports: [
    AuthModule,
    ServersModule,
    DockerModule,
    EventsModule,
    StatusBusModule,
  ],
  providers: [ConsoleGateway, StatsGateway, StatusGateway],
})
export class WsModule {}
