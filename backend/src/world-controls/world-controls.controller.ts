import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ServerQueryService } from '../servers/server-query.service';
import { WorldControlsService } from './world-controls.service';
import { QUICK_ACTIONS } from './world-controls.constants';

const quickSchema = z.object({
  action: z.enum(Object.keys(QUICK_ACTIONS) as [string, ...string[]]),
});

/** World quick controls (Overview tab). Ports the `/servers/:id/world/*` cluster of `api.ts`. */
@Controller('api/servers/:id/world')
export class WorldControlsController {
  constructor(
    private readonly serverQuery: ServerQueryService,
    private readonly worldControls: WorldControlsService,
  ) {}

  @Get('state')
  async state(@Param('id') id: string) {
    await this.serverQuery.mustGet(id);
    try {
      return {
        ok: true,
        running: true,
        state: await this.worldControls.getState(id),
      };
    } catch {
      return { ok: true, running: false, state: {} };
    }
  }

  @Post('quick')
  async quick(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    await this.serverQuery.mustGet(id);
    const { action } = quickSchema.parse(body);
    const result = await this.worldControls.runQuick(id, action, {
      actor: req.user!.username,
    });
    return { ok: true, ...result };
  }
}
