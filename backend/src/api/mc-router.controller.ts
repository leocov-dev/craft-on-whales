import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { currentUser } from '../auth/current-user';
import { McRouterService } from '../mc-router/mc-router.service';
import { ServerLifecycleService } from '../servers/server-lifecycle.service';

// A dot-separated run of DNS labels (1-63 chars each, alnum + hyphen, no
// leading/trailing hyphen) — a real domain, not a bare word, since it's
// meant to be a registrable base domain servers' subdomains attach to.
const DOMAIN_RE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

const configSchema = z.object({
  enabled: z.coerce.boolean(),
  listenPort: z.coerce.number().int().min(1024).max(65535),
  baseDomain: z
    .union([
      z.literal(''),
      z
        .string()
        .trim()
        .toLowerCase()
        .max(253)
        .regex(DOMAIN_RE, 'Use a domain like "example.com"'),
    ])
    .optional()
    .default(''),
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
  constructor(
    private readonly mcRouter: McRouterService,
    private readonly lifecycle: ServerLifecycleService,
  ) {}

  @Get()
  async get() {
    return {
      ok: true,
      config: await this.mcRouter.getConfig(),
      routes: await this.mcRouter.listRoutes(),
    };
  }

  @Post()
  async set(@Body() body: unknown, @Req() req: Request) {
    const input = configSchema.parse(body);
    const before = await this.mcRouter.getConfig();
    const cfg = await this.mcRouter.setConfig(input);
    if (cfg.enabled) await this.mcRouter.activate();
    else await this.mcRouter.deactivate();
    // Server containers carry the composed hostname as a label, so a new base
    // domain only reaches them via a recreate (see refreshRoutedServers).
    const routedServers =
      before.baseDomain !== cfg.baseDomain
        ? await this.lifecycle.refreshRoutedServers({
            actor: currentUser(req).username,
          })
        : undefined;
    return {
      ok: true,
      config: cfg,
      routes: await this.mcRouter.listRoutes(),
      routedServers,
    };
  }
}
