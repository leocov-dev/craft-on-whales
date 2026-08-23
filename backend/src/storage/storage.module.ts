import { Module } from '@nestjs/common';
import { StorageIndexModule } from './storage-index.module';
import { PathGuardModule } from './path-guard.module';
import { LibraryModule } from '../library/library.module';
import { CrashesModule } from '../crashes/crashes.module';
import { StorageCleanupService } from './storage-cleanup.service';
import { StorageController } from './storage.controller';

// A separate leaf module (not merged into StorageIndexModule) deliberately:
// StorageIndexModule already sits on a forwardRef()'d cycle
// (ServersModule -> SchedulerModule -> WorldsModule -> StorageIndexModule ->
// ServersModule), and LibraryModule imports StorageIndexModule — adding
// LibraryModule/CrashesModule as StorageIndexModule imports would close a
// second cycle (StorageIndexModule <-> LibraryModule) on top of the first.
// Nothing imports StorageModule back, so it adds zero new cycle risk here.
@Module({
  imports: [StorageIndexModule, PathGuardModule, LibraryModule, CrashesModule],
  controllers: [StorageController],
  providers: [StorageCleanupService],
  exports: [StorageCleanupService],
})
export class StorageModule {}
