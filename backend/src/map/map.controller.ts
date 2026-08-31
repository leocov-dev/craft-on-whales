import { Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ServerQueryService } from '../servers/server-query.service';
import { MapService } from './map.service';
import type { MapConfig } from '../../../shared/types/map';
import { currentUser } from '../auth/current-user';

/** Live map (BlueMap). Ports the `/servers/:id/map*` cluster of `api.ts`. */
@Controller('api/servers/:id/map')
export class MapController {
  constructor(
    private readonly serverQuery: ServerQueryService,
    private readonly map: MapService,
  ) {}

  @Get()
  async get(@Param('id') id: string): Promise<{ ok: true } & MapConfig> {
    const server = await this.serverQuery.mustGet(id);
    const cfg = await this.map.getMapConfig(server.id);
    return {
      ok: true,
      enabled: cfg.enabled,
      hostPort: cfg.hostPort,
      supported: this.map.supportsMap(server),
    };
  }

  @Post('enable')
  async enable(@Param('id') id: string, @Req() req: Request) {
    await this.serverQuery.mustGet(id);
    return {
      ok: true,
      ...(await this.map.enableMap(id, { actor: currentUser(req).username })),
    };
  }

  @Post('disable')
  async disable(@Param('id') id: string, @Req() req: Request) {
    await this.serverQuery.mustGet(id);
    await this.map.disableMap(id, { actor: currentUser(req).username });
    return { ok: true };
  }
}
