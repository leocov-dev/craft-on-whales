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
  UseGuards,
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
import { BlockedDownloadException } from './blocked-download.exception';
import {
  ContentImportService,
  IMPORT_MAX_BYTES,
} from './content-import.service';
import { TasksService } from '../tasks/tasks.service';
import { currentUser } from '../auth/current-user';
import { ServerPermissionGuard } from '../permissions/server-permission.guard';
import { RequireServerPermission } from '../permissions/require-server-permission.decorator';

// Add-by-link, and the manual-upload completion of a blocked one.
const installSchema = z.object({
  url: z.string().trim().min(3).max(500),
  kind: z.enum(['mod', 'plugin', 'datapack', 'resourcepack']).optional(),
});

// A blocked update's completion also names the row it replaces.
const manualSchema = installSchema.extend({
  replaceContentId: z.string().trim().min(1).max(40).optional(),
});

const uploadSchema = z.object({
  excludeFilename: z.string().trim().min(1).max(300).optional(),
});

// Multipart fields arrive as strings.
const importSchema = z.object({
  applyOverrides: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

/**
 * Installed-mod CRUD for one server. Ports the `/servers/:id/mods*` and
 * `/servers/:id/pending-downloads*` section of legacy `src/web/routes/api.ts`.
 */
@Controller('api/servers/:id')
@UseGuards(ServerPermissionGuard)
export class ModsController {
  constructor(
    private readonly mods: ModsService,
    private readonly serverQuery: ServerQueryService,
    private readonly dbService: DbService,
    private readonly imports: ContentImportService,
    private readonly tasks: TasksService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  @RequireServerPermission('view')
  @Get('mods')
  async list(@Param('id') id: string) {
    return { ok: true, mods: await this.mods.listContent(id) };
  }

  @RequireServerPermission('content')
  @Post('mods')
  async install(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { url, kind } = parseBody(installSchema, body);
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
  @RequireServerPermission('content')
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

    // Modrinth, CurseForge, Hangar, SpigotMC and GitHub; anything else 409s.
    const ref = await this.mods.updateRefFor(lib, check.latestVersion);

    // Resolve before removing: a newer build that can't be downloaded
    // automatically (BlockedDownload: CurseForge distribution disabled,
    // Hangar external, SpigotMC premium/external) must not cost the user the
    // installed one. Its 409 also carries `updateRef`, the pinned link the UI
    // completes the update with (mods/manual + replaceContentId).
    try {
      await this.mods.assertResolvable(server.id, ref);
    } catch (err) {
      if (err instanceof BlockedDownloadException)
        throw new ConflictException({
          ...(err.getResponse() as Record<string, unknown>),
          updateRef: ref,
        });
      throw err;
    }
    const wasEnabled = Boolean(row.enabled);
    await this.mods.removeContent(server.id, row.filename, { actor });
    const result = await this.mods.installFromUrl(server.id, ref, {
      actor,
      kind: row.kind as
        'mod' | 'plugin' | 'datapack' | 'resourcepack' | undefined,
      importId: row.importId,
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

  @RequireServerPermission('content')
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

  @RequireServerPermission('content')
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

  @RequireServerPermission('view')
  @Get('pending-downloads')
  async pending(@Param('id') id: string) {
    await this.serverQuery.mustGet(id);
    return { ok: true, mods: this.mods.pendingDownloads(id) };
  }

  @RequireServerPermission('content')
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

  /**
   * Import a zip of jars or a Modrinth .mrpack (multipart `file`, optional
   * `applyOverrides` = "false" to leave override files out). Runs as a task;
   * poll `GET /api/tasks/:taskId`, whose `result` is a ContentImportReport.
   */
  @RequireServerPermission('content')
  @Post('mods/import')
  @UseInterceptors(
    FileInterceptor('file', {
      dest: os.tmpdir(),
      limits: { fileSize: IMPORT_MAX_BYTES, files: 1 },
    }),
  )
  async importArchive(
    @Req() req: Request,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    const actor = currentUser(req).username;
    let applyOverrides: boolean;
    try {
      if (!/\.(zip|mrpack)$/i.test(file.originalname))
        throw new BadRequestException('Upload a .zip or .mrpack file');
      ({ applyOverrides } = parseBody(importSchema, body ?? {}));
      await this.imports.assertImportable(id);
    } catch (err) {
      await fs.rm(file.path, { force: true }).catch(() => {});
      throw err;
    }
    const taskId = this.tasks.run(
      `Importing ${file.originalname}`,
      { serverId: id, actor },
      async (t) => {
        try {
          return await this.imports.importArchive(
            id,
            file.path,
            file.originalname,
            { actor, applyOverrides, onStep: (label) => t.step(label) },
          );
        } finally {
          await fs.rm(file.path, { force: true }).catch(() => {});
        }
      },
    );
    return { ok: true, taskId };
  }

  @RequireServerPermission('view')
  @Get('mods/imports')
  async listImports(@Param('id') id: string) {
    await this.serverQuery.mustGet(id);
    return { ok: true, imports: await this.imports.list(id) };
  }

  /** Remove an import's jars and revert its override files. */
  @RequireServerPermission('content')
  @Delete('mods/imports/:importId')
  async removeImport(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('importId') importId: string,
  ) {
    return {
      ok: true,
      ...(await this.imports.remove(id, importId, {
        actor: currentUser(req).username,
      })),
    };
  }

  /**
   * Complete an add-by-link install that 409'd with `blocked` (the file
   * can't be fetched automatically): multipart `file` (the jar the user
   * downloaded), `url` (the same link that was blocked), optional `kind`,
   * and for a blocked update, `replaceContentId` (the row being updated;
   * `url` is then the update 409's `updateRef`).
   * See MODS_NOTES.md, "Blocked-download fallback".
   */
  @RequireServerPermission('content')
  @Post('mods/manual')
  @UseInterceptors(
    FileInterceptor('file', {
      dest: os.tmpdir(),
      limits: { fileSize: 250 * 1024 * 1024, files: 1 },
    }),
  )
  async manual(
    @Req() req: Request,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: unknown,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    try {
      const { url, kind, replaceContentId } = parseBody(
        manualSchema,
        body ?? {},
      );
      const result = await this.mods.installManualUpload(
        id,
        file.path,
        file.originalname,
        url,
        { actor: currentUser(req).username, kind, replaceContentId },
      );
      return {
        ok: true,
        installed: {
          name: result.library.name,
          filename: result.filename,
          version: result.library.version,
        },
        verified: result.verified,
      };
    } finally {
      await fs.rm(file.path, { force: true }).catch(() => {});
    }
  }

  @RequireServerPermission('content')
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
