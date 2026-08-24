import { forwardRef, Module } from '@nestjs/common';
import { DockerModule } from '../docker/docker.module';
import { ServersModule } from '../servers/servers.module';
import { PathGuardModule } from '../storage/path-guard.module';
import { StorageIndexModule } from '../storage/storage-index.module';
import { LibraryModule } from '../library/library.module';
import { MapModule } from '../map/map.module';
import { WorldArchiveService } from './world-archive.service';
import { WorldPropsService } from './world-props.service';
import { WorldLibraryService } from './world-library.service';
import { WorldSaveLockService } from './world-save-lock.service';
import { WorldOperationsService } from './world-operations.service';
import { WorldRuntimeService } from './world-runtime.service';
import { WorldTransferService } from './world-transfer.service';
import { WorldLifecycleService } from './world-lifecycle.service';
import { BackupsService } from './backups.service';
import { WorldsController, ServerWorldsController } from './worlds.controller';

@Module({
  // forwardRef: WorldsModule sits on the ServersModule -> SchedulerModule ->
  // WorldsModule -> ServersModule cycle created once SchedulerModule
  // (forwardRef'd from ServersModule) pulled WorldsModule in.
  imports: [
    DockerModule,
    forwardRef(() => ServersModule),
    PathGuardModule,
    StorageIndexModule,
    LibraryModule,
    forwardRef(() => MapModule),
  ],
  controllers: [WorldsController, ServerWorldsController],
  providers: [
    WorldArchiveService,
    WorldPropsService,
    WorldLibraryService,
    WorldSaveLockService,
    BackupsService,
    WorldRuntimeService,
    WorldTransferService,
    WorldLifecycleService,
    WorldOperationsService,
  ],
  exports: [
    WorldArchiveService,
    WorldPropsService,
    WorldLibraryService,
    WorldSaveLockService,
    BackupsService,
    WorldRuntimeService,
    WorldTransferService,
    WorldLifecycleService,
    WorldOperationsService,
  ],
})
export class WorldsModule {}
