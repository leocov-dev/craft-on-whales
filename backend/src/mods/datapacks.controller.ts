import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { currentUser } from '../auth/current-user';
import { RequireServerPermission } from '../permissions/require-server-permission.decorator';
import { ServerPermissionGuard } from '../permissions/server-permission.guard';
import { parseBody } from '../utils/parse-body';
import { DatapacksService } from './datapacks.service';

/** Datapacks of a server's active world. Install goes through the shared `POST mods` add-by-link with `kind: 'datapack'`. */
@Controller('api/servers/:id')
@UseGuards(ServerPermissionGuard)
export class DatapacksController {
  constructor(private readonly datapacks: DatapacksService) {}

  @RequireServerPermission('view')
  @Get('datapacks')
  async list(@Param('id') id: string) {
    return { ok: true, datapacks: await this.datapacks.listDatapacks(id) };
  }

  @RequireServerPermission('content')
  @Post('datapacks/toggle')
  async toggle(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { file, enabled } = parseBody(
      z.object({ file: z.string().min(1).max(200), enabled: z.boolean() }),
      body,
    );
    return {
      ok: true,
      ...(await this.datapacks.setEnabled(id, file, enabled, {
        actor: currentUser(req).username,
      })),
    };
  }

  @RequireServerPermission('content')
  @Delete('datapacks/:file')
  async remove(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('file') file: string,
  ) {
    return {
      ok: true,
      ...(await this.datapacks.removeDatapack(id, file, {
        actor: currentUser(req).username,
      })),
    };
  }
}
