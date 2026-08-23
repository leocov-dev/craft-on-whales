import { Global, Module } from '@nestjs/common';
import { PathGuardService } from './path-guard.service';
import { DataRootService } from './data-root.service';

@Global()
@Module({
  providers: [PathGuardService, DataRootService],
  exports: [PathGuardService, DataRootService],
})
export class PathGuardModule {}
