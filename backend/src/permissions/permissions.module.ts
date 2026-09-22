import { Global, Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { EventsModule } from '../events/events.module';
import { PermissionsService } from './permissions.service';
import { ServerPermissionGuard } from './server-permission.guard';
import { PermissionsController } from './permissions.controller';

/**
 * Global so `ServerPermissionGuard`/`PermissionsService` are injectable from
 * any feature module's controller (`@UseGuards(ServerPermissionGuard)`)
 * without every one of them importing this module individually — the same
 * reasoning as `AuthModule`'s `SessionAuthGuard`/`RolesGuard` being reused
 * repo-wide. See `PERMISSIONS_NOTES.md`.
 */
@Global()
@Module({
  imports: [DbModule, EventsModule],
  providers: [PermissionsService, ServerPermissionGuard],
  controllers: [PermissionsController],
  exports: [PermissionsService, ServerPermissionGuard],
})
export class PermissionsModule {}
