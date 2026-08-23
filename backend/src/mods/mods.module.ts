import { forwardRef, Module } from '@nestjs/common';
import { ServersModule } from '../servers/servers.module';
import { StorageIndexModule } from '../storage/storage-index.module';
import { LibraryModule } from '../library/library.module';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { ApiCacheService } from './api-cache.service';
import { ModrinthApiService } from './modrinth-api.service';
import { CurseforgeApiService } from './curseforge-api.service';
import { GtnhApiService } from './gtnh-api.service';
import { LoaderVersionsService } from './loader-versions.service';
import { ModBrowserService } from './mod-browser.service';
import { ModsService } from './mods.service';
import { ModsController, ModBrowserController } from './mods.controller';

// forwardRef: ModsModule sits on the ServersModule -> SchedulerModule ->
// UpdatesModule -> ModsModule -> ServersModule cycle created once
// SchedulerModule (forwardRef'd from ServersModule) pulled UpdatesModule in.
@Module({
  imports: [forwardRef(() => ServersModule), StorageIndexModule, LibraryModule, ApiKeysModule],
  controllers: [ModsController, ModBrowserController],
  providers: [ApiCacheService, ModrinthApiService, CurseforgeApiService, GtnhApiService, LoaderVersionsService, ModBrowserService, ModsService],
  exports: [ApiCacheService, ModrinthApiService, CurseforgeApiService, GtnhApiService, LoaderVersionsService, ModBrowserService, ModsService],
})
export class ModsModule {}
