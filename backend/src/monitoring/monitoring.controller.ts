import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { currentUser } from '../auth/current-user';
import { OverviewService } from './overview.service';
import { HealthService } from './health.service';
import { ServerPermissionGuard } from '../permissions/server-permission.guard';
import { RequireServerPermission } from '../permissions/require-server-permission.decorator';

/** Live-tab data. TPS/MSPT ride the stats socket instead (see StatsGateway). */
@Controller('api/servers/:id')
@UseGuards(ServerPermissionGuard)
export class MonitoringController {
  constructor(private readonly health: HealthService) {}

  @Get('health')
  @RequireServerPermission('view')
  async serverHealth(@Param('id') id: string) {
    return { ok: true, health: await this.health.forServer(id) };
  }
}

/** Dashboard-wide monitoring; scoped to the servers the caller may view. */
@Controller('api/monitoring')
export class MonitoringOverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Get('overview')
  async resourceOverview(@Req() req: Request) {
    return {
      ok: true,
      overview: await this.overview.forUser(currentUser(req)),
    };
  }
}
