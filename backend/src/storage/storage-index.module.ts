import { forwardRef, Module } from '@nestjs/common';
import { ServersModule } from '../servers/servers.module';
import { StorageIndexService } from './storage-index.service';

@Module({
  // forwardRef: StorageIndexModule sits on the ServersModule -> SchedulerModule
  // -> WorldsModule -> StorageIndexModule -> ServersModule cycle created once
  // SchedulerModule (forwardRef'd from ServersModule) pulled WorldsModule in.
  imports: [forwardRef(() => ServersModule)],
  providers: [StorageIndexService],
  exports: [StorageIndexService],
})
export class StorageIndexModule {}
