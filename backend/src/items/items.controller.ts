import { Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ServerQueryService } from '../servers/server-query.service';
import { ItemRegistryService } from './item-registry.service';
import { TasksService } from '../tasks/tasks.service';

const searchSchema = z.object({
  q: z.string().trim().max(120).optional(),
  mod: z.string().trim().max(120).optional(),
  kind: z.enum(['item', 'block']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});

/**
 * Item registry API (JEI-style browser). Ports `src/web/routes/items.ts`,
 * mounted at `/api/servers/:id/items`.
 */
@Controller('api/servers/:id/items')
export class ItemsController {
  constructor(
    private readonly serverQuery: ServerQueryService,
    private readonly itemRegistry: ItemRegistryService,
    private readonly tasks: TasksService
  ) {}

  @Get()
  async search(@Param('id') id: string, @Query() query: Record<string, unknown>) {
    const server = this.serverQuery.mustGet(id);
    const params = searchSchema.parse(query);
    const { items, total } = await this.itemRegistry.search(server.id, params);
    const registry = await this.itemRegistry.getRegistry(server.id); // cache hit — just built above
    return {
      ok: true,
      items,
      total,
      mods: registry.mods,
      iconBase: this.itemRegistry.iconBaseUrl(),
      registry: { count: registry.items.length, builtAt: registry.builtAt, buildMs: registry.buildMs },
    };
  }

  @Post('rebuild')
  @HttpCode(202)
  rebuild(@Param('id') id: string, @Req() req: Request) {
    const server = this.serverQuery.mustGet(id);
    const actor = req.user ? req.user.username : 'admin';
    const taskId = this.tasks.run(
      `Rebuilding item registry for ${server.display_name}`,
      { serverId: server.id, actor },
      async (t) => {
        t.step('Scanning mod jars & the server jar for item names');
        const registry = await this.itemRegistry.getRegistry(server.id, {
          force: true,
          onProgress: (done: number, total: number, label?: string) => {
            t.progress(done, total);
            if (label) t.log(label);
          },
        });
        return { items: registry.items.length, mods: registry.mods.length, buildMs: registry.buildMs };
      }
    );
    return { ok: true, taskId };
  }
}
