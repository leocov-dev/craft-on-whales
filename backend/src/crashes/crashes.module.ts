import { Module } from '@nestjs/common';
import { ServersModule } from '../servers/servers.module';
import { PathGuardModule } from '../storage/path-guard.module';
import { CrashParserService } from './crash-parser.service';
import { CrashesService } from './crashes.service';
import { CrashesController } from './crashes.controller';

@Module({
  imports: [ServersModule, PathGuardModule],
  controllers: [CrashesController],
  providers: [CrashParserService, CrashesService],
  exports: [CrashParserService, CrashesService],
})
export class CrashesModule {}
