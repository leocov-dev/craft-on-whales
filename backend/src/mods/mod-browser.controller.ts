import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { parseBody } from '../utils/parse-body';
import { ModrinthApiService } from './modrinth-api.service';
import { ModBrowserService } from './mod-browser.service';
import { LoaderVersionsService } from './loader-versions.service';
import {
  ModBrowserOrchestratorService,
  MOD_LOADERS,
  fromModsSchema,
} from './mod-browser-orchestrator.service';
import { requireAdminForOverrides } from '../api/docker-overrides.schema';
import { currentUser } from '../auth/current-user';

/**
 * Mod search/browse/dependency-resolution + the "From mods" server-creation
 * wizard. Ports the `/modrinth/search`, `/loaders/versions`, `/mods/search`,
 * `/mods/versions`, `/mods/deps`, `/servers/from-mods` section of legacy
 * `src/web/routes/api.ts`.
 */
@Controller('api')
export class ModBrowserController {
  constructor(
    private readonly modrinth: ModrinthApiService,
    private readonly modBrowser: ModBrowserService,
    private readonly loaderVersions: LoaderVersionsService,
    private readonly orchestrator: ModBrowserOrchestratorService,
  ) {}

  @Get('modrinth/search')
  async modrinthSearch(@Req() req: Request) {
    const q = req.query;
    const qStr = (v: unknown): string => (typeof v === 'string' ? v : '');
    const results = await this.modrinth.search({
      query: qStr(q.q),
      kind: (qStr(q.kind) || 'mod') as
        'mod' | 'plugin' | 'datapack' | 'resourcepack' | 'modpack',
      loader: q.loader ? qStr(q.loader) : undefined,
      mcVersion: q.mc ? qStr(q.mc) : undefined,
    });
    return { ok: true, results };
  }

  @Get('loaders/versions')
  async loaderBuilds(@Req() req: Request) {
    const { loader, mc } = parseBody(
      z.object({
        loader: z.enum(MOD_LOADERS),
        mc: z.string().trim().max(32).optional(),
      }),
      {
        loader: req.query.loader,
        mc: req.query.mc || undefined,
      },
    );
    return { ok: true, ...(await this.loaderVersions.getBuilds(loader, mc)) };
  }

  @Get('mods/search')
  async browse(@Req() req: Request) {
    const { q, platform, loader, mc } = parseBody(
      z.object({
        q: z.string().trim().max(120).default(''),
        platform: z.enum(['modrinth', 'curseforge']).default('modrinth'),
        loader: z.enum(MOD_LOADERS).optional(),
        mc: z.string().trim().max(32).optional(),
      }),
      {
        q: req.query.q || '',
        platform: req.query.platform || undefined,
        loader: req.query.loader || undefined,
        mc: req.query.mc || undefined,
      },
    );
    return {
      ok: true,
      results: await this.modBrowser.search({ query: q, platform, loader, mc }),
    };
  }

  @Get('mods/versions')
  async versions(@Req() req: Request) {
    const { platform, ref, loader, mc } = parseBody(
      z.object({
        platform: z.enum(['modrinth', 'curseforge']),
        ref: z.string().trim().min(1).max(200),
        loader: z.enum(MOD_LOADERS).optional(),
        mc: z.string().trim().max(32).optional(),
      }),
      {
        platform: req.query.platform,
        ref: req.query.ref,
        loader: req.query.loader || undefined,
        mc: req.query.mc || undefined,
      },
    );
    return {
      ok: true,
      versions: await this.modBrowser.versions({ platform, ref, loader, mc }),
    };
  }

  @Post('mods/deps')
  async deps(@Body() body: unknown) {
    const { loader, mc, selection } = parseBody(
      z.object({
        loader: z.enum(MOD_LOADERS),
        mc: z.string().trim().max(32).optional(),
        selection: z
          .array(
            z.object({
              platform: z.enum(['modrinth', 'curseforge']),
              ref: z.string().trim().min(1).max(200),
              versionId: z.string().trim().min(1).max(60),
            }),
          )
          .max(50),
      }),
      body,
    );
    return {
      ok: true,
      ...(await this.modBrowser.resolveDependencies({ loader, mc, selection })),
    };
  }

  @Post('servers/from-mods')
  fromMods(@Req() req: Request, @Body() body: unknown) {
    const input = parseBody(fromModsSchema, body);
    requireAdminForOverrides(req, input);
    const actor = currentUser(req).username;
    const taskId = this.orchestrator.createFromMods(input, actor);
    return { ok: true, taskId };
  }
}
