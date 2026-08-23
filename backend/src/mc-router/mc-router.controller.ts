import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { McRouterService } from './mc-router.service';

const configSchema = z.object({
  enabled: z.coerce.boolean(),
  listenPort: z.coerce.number().int().min(1024).max(65535),
  autoScaleUp: z.coerce.boolean(),
  autoScaleDown: z.coerce.boolean(),
  autoScaleDownAfter: z
    .string()
    .trim()
    .regex(/^\d+[smh]$/, 'Use a duration like "10m", "1h", or "30s"'),
  autoScaleAsleepMotd: z.string().max(200).optional(),
  autoScaleLoadingMotd: z.string().max(200).optional(),
});

/**
 * mc-router admin API. Ports `src/web/routes/mcRouter.ts` — global settings
 * + the current per-server route list. Admin-only, matching legacy's
 * `router.use(requireRole('admin'))`.
 */
@Controller('api/mc-router')
@UseGuards(RolesGuard)
@Roles('admin')
export class McRouterController {
  constructor(private readonly mcRouter: McRouterService) {}

  @Get()
  get() {
    return { ok: true, config: this.mcRouter.getConfig(), routes: this.mcRouter.listRoutes() };
  }

  @Post()
  async set(@Body() body: unknown) {
    const input = configSchema.parse(body);
    const cfg = this.mcRouter.setConfig(input);
    if (cfg.enabled) await this.mcRouter.activate();
    else await this.mcRouter.deactivate();
    return { ok: true, config: cfg, routes: this.mcRouter.listRoutes() };
  }
}
