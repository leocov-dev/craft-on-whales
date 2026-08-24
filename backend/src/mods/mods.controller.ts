import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Delete,
  Req,
  Param,
  Body,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { z, ZodError } from 'zod';
import { eq, and } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { serverContent, libraryFiles, updateChecks } from '../db/schema';
import { ServerQueryService } from '../servers/server-query.service';
import { ModsService } from './mods.service';
import { ModrinthApiService } from './modrinth-api.service';
import { ModBrowserService } from './mod-browser.service';
import { LoaderVersionsService } from './loader-versions.service';
import {
  ModBrowserOrchestratorService,
  MOD_LOADERS,
  fromModsSchema,
} from './mod-browser-orchestrator.service';

function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  try {
    return schema.parse(body);
  } catch (err) {
    if (err instanceof ZodError)
      throw new BadRequestException(
        err.issues[0]?.message || 'Invalid request',
      );
    throw err;
  }
}

interface OverridesInput {
  containerName?: string;
  networkName?: string;
  extraPorts?: unknown;
  extraBinds?: unknown;
}
function overridesPresent(input: OverridesInput): boolean {
  return (
    input.containerName !== undefined ||
    input.networkName !== undefined ||
    input.extraPorts !== undefined ||
    input.extraBinds !== undefined
  );
}
function requireAdminForOverrides(req: Request, input: OverridesInput): void {
  if (overridesPresent(input) && req.user?.role !== 'admin') {
    throw new ForbiddenException(
      'Advanced Docker settings (container name, network, extra ports/binds) require the admin role.',
    );
  }
}

/**
 * Installed-mod CRUD for one server. Ports the `/servers/:id/mods*` and
 * `/servers/:id/pending-downloads*` section of legacy `src/web/routes/api.ts`.
 */
@Controller('api/servers/:id')
export class ModsController {
  constructor(
    private readonly mods: ModsService,
    private readonly serverQuery: ServerQueryService,
    private readonly dbService: DbService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  @Get('mods')
  async list(@Param('id') id: string) {
    return { ok: true, mods: await this.mods.listContent(id) };
  }

  @Post('mods')
  async install(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { url, kind } = parseBody(
      z.object({
        url: z.string().trim().min(3).max(500),
        kind: z.enum(['mod', 'plugin', 'datapack', 'resourcepack']).optional(),
      }),
      body,
    );
    const result = await this.mods.installFromUrl(id, url, {
      actor: req.user!.username,
      kind,
    });
    return {
      ok: true,
      installed: {
        name: result.library.name,
        filename: result.filename,
        version: result.library.version,
      },
    };
  }

  // Update one overlay mod to its latest checked version. Accepts the
  // installed filename ({file}) or the server_content row id ({contentId}).
  @Post('mods/update')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { file, contentId } = parseBody(
      z
        .object({
          file: z.string().min(1).max(200).optional(),
          contentId: z.string().trim().max(40).optional(),
        })
        .refine((v) => Boolean(v.file) || Boolean(v.contentId), {
          message: 'Provide file or contentId',
        }),
      body,
    );
    const server = await this.serverQuery.mustGet(id);
    const actor = req.user!.username;

    const [row] = contentId
      ? await this.db
          .select()
          .from(serverContent)
          .where(
            and(
              eq(serverContent.id, contentId),
              eq(serverContent.serverId, server.id),
            ),
          )
          .limit(1)
      : await this.db
          .select()
          .from(serverContent)
          .where(
            and(
              eq(serverContent.serverId, server.id),
              eq(serverContent.filename, file!),
            ),
          )
          .limit(1);
    if (!row)
      throw new NotFoundException(
        'This file is not panel-managed — reinstall it from a URL instead',
      );
    if (row.managedBy === 'pack')
      throw new ConflictException(
        'Pack-managed content updates with the pack — upgrade the modpack instead',
      );

    const lib = row.libraryId
      ? (
          await this.db
            .select()
            .from(libraryFiles)
            .where(eq(libraryFiles.id, row.libraryId))
            .limit(1)
        )[0]
      : null;
    if (!lib || !lib.projectId)
      throw new ConflictException(
        'No update source is known for this mod (installed from a direct URL or upload)',
      );

    const [check] = await this.db
      .select()
      .from(updateChecks)
      .where(
        and(
          eq(updateChecks.subjectType, 'content'),
          eq(updateChecks.subjectId, row.id),
        ),
      )
      .limit(1);
    if (!check || !check.latestVersion)
      throw new ConflictException(
        'No newer version is known — run an update check first',
      );

    let ref: string;
    if (lib.platform === 'modrinth')
      ref = `https://modrinth.com/mod/${lib.projectId}/version/${check.latestVersion}`;
    else if (lib.platform === 'curseforge')
      ref = `https://www.curseforge.com/minecraft/mc-mods/${lib.projectId}/files/${check.latestVersion}`;
    else
      throw new ConflictException(
        `Cannot auto-update content from platform "${lib.platform}"`,
      );

    const wasEnabled = Boolean(row.enabled);
    await this.mods.removeContent(server.id, row.filename, { actor });
    const result = await this.mods.installFromUrl(server.id, ref, {
      actor,
      kind: row.kind as
        'mod' | 'plugin' | 'datapack' | 'resourcepack' | undefined,
    });
    if (!wasEnabled)
      await this.mods.setEnabled(server.id, result.filename, false, { actor });
    return {
      ok: true,
      installed: {
        name: result.library.name,
        filename: result.filename,
        version: result.library.version,
        enabled: wasEnabled,
      },
    };
  }

  @Post('mods/toggle')
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
      ...(await this.mods.setEnabled(id, file, enabled, {
        actor: req.user!.username,
      })),
    };
  }

  @Delete('mods/:file')
  async remove(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('file') file: string,
  ) {
    return {
      ok: true,
      ...(await this.mods.removeContent(id, file, {
        actor: req.user!.username,
      })),
    };
  }

  @Get('pending-downloads')
  async pending(@Param('id') id: string) {
    await this.serverQuery.mustGet(id);
    return { ok: true, mods: this.mods.pendingDownloads(id) };
  }

  @Post('pending-downloads/exclude')
  async exclude(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    await this.serverQuery.mustGet(id);
    const { filename } = parseBody(
      z.object({ filename: z.string().min(1).max(300) }),
      body,
    );
    const token = this.mods.pendingExcludeToken(id, filename);
    await this.mods.excludePackMod(id, token, { actor: req.user!.username });
    this.mods.clearPendingLine(id, filename);
    return { ok: true, excluded: token, mods: this.mods.pendingDownloads(id) };
  }

  @Post('mods/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      dest: os.tmpdir(),
      limits: { fileSize: 250 * 1024 * 1024, files: 1 },
    }),
  )
  async upload(
    @Req() req: Request,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { excludeFilename?: string },
  ) {
    await this.serverQuery.mustGet(id);
    if (!file) throw new BadRequestException('No file uploaded');
    const excludeFilename = body?.excludeFilename || null;
    const excludeToken = excludeFilename
      ? this.mods.pendingExcludeToken(id, excludeFilename)
      : null;
    try {
      const result = await this.mods.importUploadedMod(
        id,
        file.path,
        file.originalname,
        { excludeToken, actor: req.user!.username },
      );
      if (excludeFilename) this.mods.clearPendingLine(id, excludeFilename);
      return { ok: true, ...result, mods: this.mods.pendingDownloads(id) };
    } finally {
      fs.rm(file.path, { force: true }).catch(() => {});
    }
  }
}

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
    const actor = req.user!.username;
    const taskId = this.orchestrator.createFromMods(input, actor);
    return { ok: true, taskId };
  }
}
