import {
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import { z } from 'zod';
import { parseBody } from '../utils/parse-body';
import { eq, and } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { EventsService } from '../events/events.service';
import { PathGuardService } from '../storage/path-guard.service';
import { libraryFiles } from '../db/schema';
import { WorldOperationsService } from './world-operations.service';
import { WorldLibraryService } from './world-library.service';
import type { SimpleWorld } from '../../../shared/types/worlds';
import { currentUser } from '../auth/current-user';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ServerPermissionGuard } from '../permissions/server-permission.guard';
import { RequireServerPermission } from '../permissions/require-server-permission.decorator';
import { PermissionsService } from '../permissions/permissions.service';

/** `serverId` from the extract body — the source server being read from. */
function extractSourceServerId(req: { body?: unknown }): string | null {
  const body = req.body as { serverId?: unknown } | undefined;
  return typeof body?.serverId === 'string' ? body.serverId : null;
}

/** `serverId` from the install body — the target server being written to. */
function installTargetServerId(req: { body?: unknown }): string | null {
  const body = req.body as { serverId?: unknown } | undefined;
  return typeof body?.serverId === 'string' ? body.serverId : null;
}

function actorOf(req: Request): string {
  return currentUser(req).username;
}
const worldNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\\/\0]+$/, 'World names cannot contain path separators')
  .refine((v) => !v.startsWith('.'), {
    message: 'World names cannot start with a dot',
  });
const modeSchema = z.enum(['replace', 'alongside']);

function libVM(row: typeof libraryFiles.$inferSelect): SimpleWorld {
  return {
    id: row.id,
    name: row.name,
    filename: row.filename,
    size: row.sizeBytes,
    flavor: row.worldFlavor,
    mcVersion: row.version,
    source: row.worldSource,
    created: row.createdAt,
  };
}

/** Ports the global-library half of legacy `src/web/routes/worlds.ts`, mounted at /api/worlds. */
@Controller('api/worlds')
export class WorldsController {
  constructor(
    private readonly ops: WorldOperationsService,
    private readonly library: WorldLibraryService,
    private readonly db: DbService,
    private readonly events: EventsService,
    private readonly pathGuard: PathGuardService,
  ) {}

  @Get()
  async list() {
    return { ok: true, worlds: await this.library.libraryWorlds() };
  }

  // multer's `dest` must be a static value at decoration time (no DI available
  // here) — os.tmpdir() instead of the legacy dataPath('tmp'); the uploaded
  // file is only ever read then deleted by importArchive(), so which OS temp
  // area it transits through doesn't matter for correctness.
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      dest: os.tmpdir(),
      limits: { fileSize: 20 * 1024 ** 3 },
    }),
  )
  async upload(@UploadedFile() file: Express.Multer.File, @Req() req: Request) {
    if (!file)
      throw new BadRequestException(
        'Attach a world archive (zip, .mcworld, tar or tar.gz)',
      );
    const { name } = parseBody(
      z.object({ name: z.string().trim().max(120).optional() }),
      req.body || {},
    );
    try {
      const row = await this.library.importArchive(file.path, {
        name,
        originalName: file.originalname,
        actor: actorOf(req),
      });
      return { ok: true, world: libVM(row) };
    } catch (err) {
      await fsp.rm(file.path, { force: true }).catch(() => {});
      throw err;
    }
  }

  @Post('extract')
  @UseGuards(ServerPermissionGuard)
  @RequireServerPermission('content', extractSourceServerId)
  async extract(@Req() req: Request) {
    const { serverId, name } = parseBody(
      z.object({
        serverId: z.string().trim().min(1).max(40),
        name: z.string().trim().max(120).optional(),
      }),
      req.body,
    );
    const row = await this.ops.extractFromServer(serverId, {
      name,
      actor: actorOf(req),
    });
    return { ok: true, world: libVM(row) };
  }

  @Post(':id/install')
  @UseGuards(ServerPermissionGuard)
  @RequireServerPermission('content', installTargetServerId)
  async install(@Param('id') worldId: string, @Req() req: Request) {
    const { serverId, mode, newName, confirm } = parseBody(
      z.object({
        serverId: z.string().trim().min(1).max(40),
        mode: modeSchema.default('replace'),
        newName: worldNameSchema.optional(),
        confirm: z.coerce.boolean().optional(),
      }),
      req.body,
    );
    const warnings = await this.ops.installWarnings(worldId, serverId);
    if (warnings.length && !confirm)
      return { ok: true, requiresConfirm: true, warnings };
    const result = await this.ops.installToServer(worldId, serverId, {
      mode,
      newName,
      actor: actorOf(req),
    });
    return { ok: true, ...result };
  }

  // Streams a full world save (may contain player data) — bulk sensitive
  // export, gated like the per-server world download below and the
  // existing backups/blueprints downloads.
  @Get(':id/download')
  @UseGuards(RolesGuard)
  @Roles('admin', 'operator')
  async download(@Param('id') id: string, @Res() res: Response) {
    const [lib] = await this.db.db
      .select()
      .from(libraryFiles)
      .where(and(eq(libraryFiles.id, id), eq(libraryFiles.category, 'world')))
      .limit(1);
    if (!lib) throw new NotFoundException('World not found in the library');
    const filename = lib.filename;
    res.download(
      this.pathGuard.dataPath(lib.relPath),
      filename.endsWith('.zip') ? filename : `${filename}.zip`,
    );
  }

  @Patch(':id')
  async rename(@Param('id') id: string, @Req() req: Request) {
    const { name } = parseBody(
      z.object({ name: z.string().trim().min(1).max(120) }),
      req.body,
    );
    const [lib] = await this.db.db
      .select()
      .from(libraryFiles)
      .where(and(eq(libraryFiles.id, id), eq(libraryFiles.category, 'world')))
      .limit(1);
    if (!lib) throw new NotFoundException('World not found in the library');
    await this.db.db
      .update(libraryFiles)
      .set({ name })
      .where(eq(libraryFiles.id, lib.id));
    this.events.recordEvent({
      actor: actorOf(req),
      type: 'world-renamed',
      summary: `Library world renamed: "${lib.name}" → "${name}"`,
      details: { libraryId: lib.id },
    });
    return { ok: true, world: { id: lib.id, name } };
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: Request) {
    return {
      ok: true,
      ...(await this.library.deleteLibraryWorld(id, { actor: actorOf(req) })),
    };
  }
}

/** Ports the per-server half of legacy `src/web/routes/worlds.ts`, mounted at /api/servers/:id/worlds. */
@Controller('api/servers/:id/worlds')
@UseGuards(ServerPermissionGuard)
export class ServerWorldsController {
  constructor(
    private readonly ops: WorldOperationsService,
    private readonly permissions: PermissionsService,
  ) {}

  @RequireServerPermission('view')
  @Get()
  async list(@Param('id') id: string) {
    return { ok: true, worlds: await this.ops.listServerWorlds(id) };
  }

  @RequireServerPermission('content')
  @Post('copy-to')
  async copyTo(@Param('id') id: string, @Req() req: Request) {
    const { targetServerId, mode, newName, confirm } = parseBody(
      z.object({
        targetServerId: z.string().trim().min(1).max(40),
        mode: modeSchema.default('replace'),
        newName: worldNameSchema.optional(),
        confirm: z.coerce.boolean().optional(),
      }),
      req.body,
    );
    // The route guard only checks `content` on the source `:id` — this
    // writes into targetServerId too, so it needs its own check. Mirrors
    // ServerPermissionGuard's hidden-vs-403 contract: no `view` on the
    // target looks like it doesn't exist, `view` but no `content` is a
    // plain 403.
    const targetEffective = await this.permissions.effective(
      req.user,
      targetServerId,
    );
    if (!targetEffective.includes('view')) {
      throw new NotFoundException('Server not found');
    }
    if (!targetEffective.includes('content')) {
      throw new ForbiddenException(
        "You don't have the content permission on the target server.",
      );
    }
    const warnings = await this.ops.copyWarnings(id, targetServerId);
    if (warnings.length && !confirm)
      return { ok: true, requiresConfirm: true, warnings };
    const result = await this.ops.copyBetweenServers(id, targetServerId, {
      mode,
      newName,
      actor: actorOf(req),
    });
    return {
      ok: true,
      installedAs: result.installedAs,
      mode: result.mode,
      sizeBytes: result.sizeBytes,
      warnings: result.warnings,
    };
  }

  @RequireServerPermission('content')
  @Post('duplicate')
  async duplicate(@Param('id') id: string, @Req() req: Request) {
    const { world } = parseBody(z.object({ world: worldNameSchema }), req.body);
    return {
      ok: true,
      ...(await this.ops.duplicateWorld(id, world, { actor: actorOf(req) })),
    };
  }

  @RequireServerPermission('content')
  @Post('rename')
  async rename(@Param('id') id: string, @Req() req: Request) {
    const { world, newName } = parseBody(
      z.object({ world: worldNameSchema, newName: worldNameSchema }),
      req.body,
    );
    return {
      ok: true,
      ...(await this.ops.renameWorld(id, world, newName, {
        actor: actorOf(req),
      })),
    };
  }

  @RequireServerPermission('content')
  @Post('reset')
  async reset(@Param('id') id: string, @Req() req: Request) {
    const opts = parseBody(
      z.object({
        seedMode: z.enum(['keep', 'random', 'custom']).default('random'),
        seed: z.string().trim().max(200).optional(),
        levelType: z
          .enum(['DEFAULT', 'FLAT', 'LARGEBIOMES', 'AMPLIFIED'])
          .optional(),
        backup: z.coerce.boolean().default(true),
      }),
      req.body,
    );
    return {
      ok: true,
      ...(await this.ops.resetWorld(id, { ...opts, actor: actorOf(req) })),
    };
  }

  @RequireServerPermission('content')
  @Post('activate')
  async activate(@Param('id') id: string, @Req() req: Request) {
    const { world } = parseBody(z.object({ world: worldNameSchema }), req.body);
    return {
      ok: true,
      ...(await this.ops.activateWorld(id, world, { actor: actorOf(req) })),
    };
  }

  // Pauses server saves and zips a fresh world snapshot to disk before
  // streaming it — a real side effect (not just a read), plus bulk
  // sensitive export, so it's role-gated.
  @RequireServerPermission('content')
  @Get(':world/download')
  @UseGuards(RolesGuard)
  @Roles('admin', 'operator')
  async download(
    @Param('id') id: string,
    @Param('world') worldRaw: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const world = worldNameSchema.parse(worldRaw);
    const staged = await this.ops.prepareWorldDownload(id, world, {
      actor: actorOf(req),
    });
    res.download(staged.absPath, staged.filename, () => {
      fsp.rm(staged.absPath, { force: true }).catch(() => {});
    });
  }

  @RequireServerPermission('content')
  @Delete(':world')
  async remove(
    @Param('id') id: string,
    @Param('world') worldRaw: string,
    @Req() req: Request,
  ) {
    const world = worldNameSchema.parse(worldRaw);
    return {
      ok: true,
      ...(await this.ops.deleteServerWorld(id, world, { actor: actorOf(req) })),
    };
  }
}
