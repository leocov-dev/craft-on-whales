import { forwardRef, Module } from '@nestjs/common';
import { ServersModule } from '../servers/servers.module';
import { StorageIndexModule } from '../storage/storage-index.module';
import { LibraryModule } from '../library/library.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { ApiCacheService } from './api-cache.service';
import { ModrinthApiService } from './modrinth-api.service';
import { CurseforgeApiService } from './curseforge-api.service';
import { GtnhApiService } from './gtnh-api.service';
import { PackwizApiService } from './packwiz-api.service';
import { LoaderVersionsService } from './loader-versions.service';
import { ModBrowserService } from './mod-browser.service';
import { ModManifestService } from './mod-manifest.service';
import { PendingModDownloadsService } from './pending-mod-downloads.service';
import { ModsService } from './mods.service';
import { ModBrowserOrchestratorService } from './mod-browser-orchestrator.service';
import { ModsController } from './mods.controller';
import { ModBrowserController } from './mod-browser.controller';

// forwardRef: ModsModule sits on the ServersModule -> SchedulerModule ->
// UpdatesModule -> ModsModule -> ServersModule cycle created once
// SchedulerModule (forwardRef'd from ServersModule) pulled UpdatesModule in.
@Module({
  imports: [
    forwardRef(() => ServersModule),
    StorageIndexModule,
    LibraryModule,
    ApiKeysModule,
  ],
  controllers: [ModsController, ModBrowserController],
  providers: [
    ApiCacheService,
    ModrinthApiService,
    CurseforgeApiService,
    GtnhApiService,
    PackwizApiService,
    LoaderVersionsService,
    ModBrowserService,
    ModManifestService,
    PendingModDownloadsService,
    ModsService,
    ModBrowserOrchestratorService,
  ],
  exports: [
    ApiCacheService,
    ModrinthApiService,
    CurseforgeApiService,
    GtnhApiService,
    PackwizApiService,
    LoaderVersionsService,
    ModBrowserService,
    ModManifestService,
    PendingModDownloadsService,
    ModsService,
    ModBrowserOrchestratorService,
  ],
})
export class ModsModule {}
