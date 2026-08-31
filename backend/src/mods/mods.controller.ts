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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { z } from 'zod';
import { parseBody } from '../utils/parse-body';
import { eq, and } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { serverContent, libraryFiles, updateChecks } from '../db/schema';
import { ServerQueryService } from '../servers/server-query.service';
import { ModsService } from './mods.service';
import { currentUser } from '../auth/current-user';

const uploadSchema = z.object({
  excludeFilename: z.string().trim().min(1).max(300).optional(),
});

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
      actor: currentUser(req).username,
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
    const actor = currentUser(req).username;

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

    if (lib.platform !== 'modrinth' && lib.platform !== 'curseforge')
      throw new ConflictException(
        `Cannot auto-update content from platform "${lib.platform}"`,
      );
    const ref = this.mods.refToUrl(
      lib.platform,
      lib.projectId,
      check.latestVersion,
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
        actor: currentUser(req).username,
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
        actor: currentUser(req).username,
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
    await this.mods.excludePackMod(id, token, {
      actor: currentUser(req).username,
    });
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
    @Body() body: unknown,
  ) {
    await this.serverQuery.mustGet(id);
    if (!file) throw new BadRequestException('No file uploaded');
    const { excludeFilename = null } = parseBody(uploadSchema, body ?? {});
    const excludeToken = excludeFilename
      ? this.mods.pendingExcludeToken(id, excludeFilename)
      : null;
    try {
      const result = await this.mods.importUploadedMod(
        id,
        file.path,
        file.originalname,
        { excludeToken, actor: currentUser(req).username },
      );
      if (excludeFilename) this.mods.clearPendingLine(id, excludeFilename);
      return { ok: true, ...result, mods: this.mods.pendingDownloads(id) };
    } finally {
      fs.rm(file.path, { force: true }).catch(() => {});
    }
  }
}
