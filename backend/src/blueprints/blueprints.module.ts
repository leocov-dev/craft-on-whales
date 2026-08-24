import { Module } from '@nestjs/common';
import { ServersModule } from '../servers/servers.module';
import { PathGuardModule } from '../storage/path-guard.module';
import { StorageIndexModule } from '../storage/storage-index.module';
import { PacksModule } from '../packs/packs.module';
import { LibraryModule } from '../library/library.module';
import { ModsModule } from '../mods/mods.module';
import { WorldsModule } from '../worlds/worlds.module';
import { BlueprintExportService } from './blueprint-export.service';
import { BlueprintImportService } from './blueprint-import.service';
import { BlueprintsLibraryService } from './blueprints-library.service';
import { BlueprintsController } from './blueprints.controller';

@Module({
  imports: [
    ServersModule,
    PathGuardModule,
    StorageIndexModule,
    PacksModule,
    LibraryModule,
    ModsModule,
    WorldsModule,
  ],
  controllers: [BlueprintsController],
  providers: [
    BlueprintExportService,
    BlueprintImportService,
    BlueprintsLibraryService,
  ],
  exports: [
    BlueprintExportService,
    BlueprintImportService,
    BlueprintsLibraryService,
  ],
})
export class BlueprintsModule {}
