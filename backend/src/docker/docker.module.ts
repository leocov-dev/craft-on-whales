import { Module } from '@nestjs/common';
import { DockerConnectionService } from './docker-connection.service';
import { ContainerService } from './container.service';
import { DockerLogsService } from './docker-logs.service';
import { DockerStatsService } from './docker-stats.service';
import { DockerImagesService } from './docker-images.service';
import { DockerNetworksService } from './docker-networks.service';
import { HostPathService } from './host-path.service';
import { McRouterDockerService } from './mc-router-docker.service';
import { DockerWatcherService } from './docker-watcher.service';

@Module({
  providers: [
    DockerConnectionService,
    ContainerService,
    DockerLogsService,
    DockerStatsService,
    DockerImagesService,
    DockerNetworksService,
    HostPathService,
    McRouterDockerService,
    DockerWatcherService,
  ],
  exports: [
    DockerConnectionService,
    ContainerService,
    DockerLogsService,
    DockerStatsService,
    DockerImagesService,
    DockerNetworksService,
    HostPathService,
    McRouterDockerService,
    DockerWatcherService,
  ],
})
export class DockerModule {}
