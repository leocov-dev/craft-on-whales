import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { parseBody } from '../utils/parse-body';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { currentUser } from '../auth/current-user';
import { PermissionsService } from './permissions.service';

/**
 * Admin-only API behind Settings → Permissions: the full user × server
 * matrix, and setting/clearing one (user, server) grant. Per-server
 * enforcement itself lives in `ServerPermissionGuard`, not here — this
 * controller only edits the `user_server_permissions` rows it reads.
 */
@Controller('api/permissions')
@UseGuards(RolesGuard)
@Roles('admin')
export class PermissionsController {
  constructor(private readonly permissions: PermissionsService) {}

  @Get()
  async matrix() {
    return { ok: true, ...(await this.permissions.listMatrix()) };
  }

  @Post(':userId/:serverId')
  async setGrant(
    @Req() req: Request,
    @Param('userId') userId: string,
    @Param('serverId') serverId: string,
    @Body() body: unknown,
  ) {
    const { perms } = parseBody(
      z.object({ perms: z.array(z.string()).nullable() }),
      body,
    );
    const result = await this.permissions.setGrant(userId, serverId, perms, {
      actor: currentUser(req).username,
    });
    return { ok: true, ...result };
  }
}
