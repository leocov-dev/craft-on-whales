import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import * as path from 'node:path';
import { ConfigModule } from '../config/config.module';
import { ConfigService } from '../config/config.service';
import { EventsModule } from '../events/events.module';
import { PathGuardModule } from '../storage/path-guard.module';
import { StorageIndexModule } from '../storage/storage-index.module';
import { ServersModule } from '../servers/servers.module';
import { FilesService } from './files.service';
import { FilesRouteHandlersService } from './files-route-handlers.service';
import { UploadPreflightInterceptor } from './upload-preflight.interceptor';
import { ServerFilesController } from './server-files.controller';
import { GlobalFilesController } from './global-files.controller';

@Module({
  imports: [
    ConfigModule,
    EventsModule,
    PathGuardModule,
    StorageIndexModule,
    ServersModule,
    // dest = <dataDir>/tmp: same filesystem as every upload destination, so
    // acceptUpload()'s move is a plain rename, not a cross-device copy.
    MulterModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        dest: path.join(config.dataDir, 'tmp'),
        limits: { fileSize: 4 * 1024 ** 3, files: 20 },
      }),
    }),
  ],
  controllers: [ServerFilesController, GlobalFilesController],
  providers: [
    FilesService,
    FilesRouteHandlersService,
    UploadPreflightInterceptor,
  ],
  exports: [FilesService],
})
export class FilesModule {}
