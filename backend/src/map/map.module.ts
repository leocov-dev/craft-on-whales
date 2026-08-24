import { forwardRef, Module } from '@nestjs/common';
import { PathGuardModule } from '../storage/path-guard.module';
import { ModsModule } from '../mods/mods.module';
import { DockerModule } from '../docker/docker.module';
import { ServersModule } from '../servers/servers.module';
import { WorldsModule } from '../worlds/worlds.module';
import { MapService } from './map.service';
import { MapController } from './map.controller';
import { MapProxyController } from './map-proxy.controller';

// forwardRef on BOTH ServersModule and WorldsModule: MapService needs
// ServerQueryService (servers.ts <-> map.ts is a genuine bidirectional
// require cycle in the legacy code) AND WorldPropsService (worlds.ts <->
// map.ts likewise) — both closing back through MapModule once
// ServerEnvironmentService/WorldPropsService inject MapService in turn (see
// their own forwardRef'd MapModule imports).
@Module({
  imports: [
    PathGuardModule,
    ModsModule,
    DockerModule,
    forwardRef(() => ServersModule),
    forwardRef(() => WorldsModule),
  ],
  controllers: [MapController, MapProxyController],
  providers: [MapService],
  exports: [MapService],
})
export class MapModule {}
