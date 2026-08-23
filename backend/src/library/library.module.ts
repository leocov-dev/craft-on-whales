import { Module, forwardRef } from '@nestjs/common';
import { StorageIndexModule } from '../storage/storage-index.module';
import { ServersModule } from '../servers/servers.module';
import { LibraryService } from './library.service';

// forwardRef on ServersModule: ServersModule -> SchedulerModule ->
// WorldsModule -> LibraryModule -> ServersModule is a genuine module-graph
// cycle (LibraryService.installToServer needs ServerEnvironmentService's
// ensureOwnership) — this is the edge that closes the loop.
@Module({
  imports: [StorageIndexModule, forwardRef(() => ServersModule)],
  providers: [LibraryService],
  exports: [LibraryService],
})
export class LibraryModule {}
