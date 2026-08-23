import { Controller, Get, Post, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { SolverService } from './solver.service';
import { ModrinthApiService } from '../mods/modrinth-api.service';

const solveSchema = z.object({
  projects: z.array(z.string().trim().min(1).max(100)).min(1).max(25),
});

/** Compatibility solver API. Ports `src/web/routes/solver.ts`. */
@Controller('api/solver')
export class SolverController {
  constructor(
    private readonly solver: SolverService,
    private readonly modrinth: ModrinthApiService
  ) {}

  @Get('search')
  async search(@Query('q') q?: string) {
    const query = String(q || '').trim();
    if (!query) return { ok: true, results: [] };
    const results = await this.modrinth.search({ query, kind: 'mod' });
    return {
      ok: true,
      results: results.map((r) => ({
        slug: r.slug,
        title: r.title,
        iconUrl: r.iconUrl,
        description: r.description,
        downloads: r.downloads,
      })),
    };
  }

  @Post('solve')
  async solve(@Body() body: unknown) {
    const { projects } = solveSchema.parse(body);
    return { ok: true, ...(await this.solver.solve(projects)) };
  }
}
