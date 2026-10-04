import { Controller, Get, Post, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { SolverService } from './solver.service';
import { ModBrowserService } from '../mods/mod-browser.service';

const platformSchema = z.enum(['modrinth', 'curseforge']);

const searchSchema = z.object({
  q: z.string().trim().max(120).default(''),
  platform: platformSchema.default('modrinth'),
});

const solveSchema = z.object({
  projects: z
    .array(
      z.union([
        // Original contract: a bare string is a Modrinth slug/id.
        z.string().trim().min(1).max(100),
        z.object({
          platform: platformSchema.default('modrinth'),
          ref: z.string().trim().min(1).max(100),
        }),
      ]),
    )
    .min(1)
    .max(25),
});

/** Compatibility solver API. Ports `src/web/routes/solver.ts`. */
@Controller('api/solver')
export class SolverController {
  constructor(
    private readonly solver: SolverService,
    private readonly modBrowser: ModBrowserService,
  ) {}

  /** Deliberately unfiltered by loader/MC version: the solver decides those
   *  from the final selection. CurseForge needs the stored API key (412). */
  @Get('search')
  async search(@Query() query: unknown) {
    const { q, platform } = searchSchema.parse(query);
    if (!q) return { ok: true, results: [] };
    const results = await this.modBrowser.search({
      query: q,
      platform,
    });
    return {
      ok: true,
      results: results.map((r) => ({
        platform: r.platform,
        slug: r.ref,
        title: r.name,
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
