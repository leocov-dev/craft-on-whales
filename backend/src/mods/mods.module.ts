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
import { HangarApiService } from './hangar-api.service';
import { SpigetApiService } from './spiget-api.service';
import { GithubReleasesApiService } from './github-releases-api.service';
import { JarIdentifierService } from './jar-identifier.service';
import { LoaderVersionsService } from './loader-versions.service';
import { ModBrowserService } from './mod-browser.service';
import { ModManifestService } from './mod-manifest.service';
import { PendingModDownloadsService } from './pending-mod-downloads.service';
import { ModsService } from './mods.service';
import { DatapacksService } from './datapacks.service';
import { ModBrowserOrchestratorService } from './mod-browser-orchestrator.service';
import { ContentImportService } from './content-import.service';
import { PackOverridesService } from './pack-overrides.service';
import { ServerFromZipService } from './server-from-zip.service';
import { ModsController } from './mods.controller';
import { ModBrowserController } from './mod-browser.controller';
import { DatapacksController } from './datapacks.controller';

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
  controllers: [ModsController, ModBrowserController, DatapacksController],
  providers: [
    ApiCacheService,
    ModrinthApiService,
    CurseforgeApiService,
    GtnhApiService,
    PackwizApiService,
    HangarApiService,
    SpigetApiService,
    GithubReleasesApiService,
    JarIdentifierService,
    LoaderVersionsService,
    ModBrowserService,
    ModManifestService,
    PendingModDownloadsService,
    DatapacksService,
    ModsService,
    ModBrowserOrchestratorService,
    PackOverridesService,
    ContentImportService,
    ServerFromZipService,
  ],
  exports: [
    DatapacksService,
    ApiCacheService,
    ModrinthApiService,
    CurseforgeApiService,
    GtnhApiService,
    PackwizApiService,
    HangarApiService,
    SpigetApiService,
    GithubReleasesApiService,
    JarIdentifierService,
    LoaderVersionsService,
    ModBrowserService,
    ModManifestService,
    PendingModDownloadsService,
    ModsService,
    ModBrowserOrchestratorService,
  ],
})
export class ModsModule {}
