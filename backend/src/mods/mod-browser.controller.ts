import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { parseBody } from '../utils/parse-body';
import { ModrinthApiService } from './modrinth-api.service';
import { ModBrowserService, BROWSABLE_PLATFORMS } from './mod-browser.service';
import { LoaderVersionsService } from './loader-versions.service';
import {
  ModBrowserOrchestratorService,
  MOD_LOADERS,
  BROWSE_LOADERS,
  fromModsSchema,
  modPickSchema,
} from './mod-browser-orchestrator.service';
import {
  ServerFromZipService,
  fromZipSchema,
  previewZipSchema,
  zipUploadPath,
} from './server-from-zip.service';
import { IMPORT_MAX_BYTES } from './content-import.service';
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
    private readonly fromZip: ServerFromZipService,
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
        platform: z.enum(BROWSABLE_PLATFORMS).default('modrinth'),
        loader: z.enum(BROWSE_LOADERS).optional(),
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
        platform: z.enum(BROWSABLE_PLATFORMS),
        ref: z.string().trim().min(1).max(200),
        loader: z.enum(BROWSE_LOADERS).optional(),
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
        loader: z.enum(BROWSE_LOADERS),
        mc: z.string().trim().max(32).optional(),
        selection: z.array(modPickSchema.required({ versionId: true })).max(50),
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

  /**
   * Create a server from an uploaded .mrpack or zip of jars (multipart
   * `file` plus the fromZipSchema fields). Runs as a task; poll
   * `GET /api/tasks/:taskId`, whose `result` is a ServerFromZipResult.
   */
  /**
   * Analyse an archive without creating anything. The upload stays in
   * os.tmpdir() under the returned `uploadToken` so create (or a re-preview
   * with another loader/version) doesn't need it sent again.
   */
  @Post('servers/from-zip/preview')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, os.tmpdir()),
        filename: (_req, _file, cb) => cb(null, `zipup-${nanoid(10)}.zip`),
      }),
      limits: { fileSize: IMPORT_MAX_BYTES, files: 1 },
    }),
  )
  async previewFromZip(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown,
  ) {
    const fresh = file?.path;
    try {
      const input = parseBody(previewZipSchema, body ?? {});
      if (file && input.uploadToken)
        throw new BadRequestException(
          'Provide a file or an uploadToken, not both',
        );
      let archivePath: string;
      let archiveName: string;
      let uploadToken: string;
      if (file) {
        if (!/\.(zip|mrpack)$/i.test(file.originalname))
          throw new BadRequestException('Upload a .zip or .mrpack file');
        archivePath = file.path;
        archiveName = file.originalname;
        uploadToken = file.filename;
      } else if (input.uploadToken) {
        uploadToken = input.uploadToken;
        archivePath = zipUploadPath(uploadToken);
        archiveName = '';
        await fs.access(archivePath).catch(() => {
          throw new NotFoundException('Upload expired — upload it again');
        });
      } else {
        throw new BadRequestException('No file uploaded');
      }
      const preview = await this.fromZip.previewZip(
        archivePath,
        archiveName,
        input,
      );
      return { ok: true, preview, uploadToken };
    } catch (err) {
      if (fresh) await fs.rm(fresh, { force: true }).catch(() => {});
      throw err;
    }
  }

  @Delete('servers/from-zip/preview/:token')
  async discardZipPreview(@Param('token') token: string) {
    await fs.rm(zipUploadPath(token), { force: true });
    return { ok: true };
  }

  @Post('servers/from-zip')
  @UseInterceptors(
    FileInterceptor('file', {
      dest: os.tmpdir(),
      limits: { fileSize: IMPORT_MAX_BYTES, files: 1 },
    }),
  )
  async createFromZip(
    @Req() req: Request,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown,
  ) {
    try {
      const input = parseBody(fromZipSchema, body ?? {});
      if (file && input.uploadToken)
        throw new BadRequestException(
          'Provide a file or an uploadToken, not both',
        );
      let archivePath: string;
      let originalName: string;
      if (file) {
        if (!/\.(zip|mrpack)$/i.test(file.originalname))
          throw new BadRequestException('Upload a .zip or .mrpack file');
        archivePath = file.path;
        originalName = file.originalname;
      } else if (input.uploadToken) {
        archivePath = zipUploadPath(input.uploadToken);
        originalName = input.archiveName ?? 'uploaded archive';
        await fs.access(archivePath).catch(() => {
          throw new NotFoundException('Upload expired — upload it again');
        });
      } else {
        throw new BadRequestException('No file uploaded');
      }
      const actor = currentUser(req).username;
      const taskId = this.fromZip.createFromZip(
        input,
        archivePath,
        originalName,
        actor,
      );
      return { ok: true, taskId };
    } catch (err) {
      // A fresh upload nobody will use is removed; a previewed one stays so the user can retry.
      if (file) await fs.rm(file.path, { force: true }).catch(() => {});
      throw err;
    }
  }
}
