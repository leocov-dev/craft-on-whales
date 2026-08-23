import { Module } from '@nestjs/common';
import { ServersModule } from '../servers/servers.module';
import { DockerModule } from '../docker/docker.module';
import { PlayersModule } from '../players/players.module';
import { StatusService } from './status.service';
import { StatusController } from './status.controller';

@Module({
  imports: [ServersModule, DockerModule, PlayersModule],
  controllers: [StatusController],
  providers: [StatusService],
  exports: [StatusService],
})
export class StatusModule {}
