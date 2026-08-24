import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import multer from 'multer';
import { z, ZodError } from 'zod';
import { nanoid } from 'nanoid';
import { PathGuardService } from '../storage/path-guard.service';
import { requireAdminForOverrides } from '../api/docker-overrides.schema';
import type { Server } from '../servers/types';
import { BlueprintExportService } from './blueprint-export.service';
import { BlueprintImportService } from './blueprint-import.service';
import {
  BlueprintsLibraryService,
  type DecoratedBlueprint,
} from './blueprints-library.service';
import type { BlueprintViewModel } from '../../../shared/types/blueprints';

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

// Shared "Advanced Docker Settings" fields — ports `dockerOverridesSchema.ts`.
const dockerOverridesSchema = {
  containerName: z
    .union([
      z.literal(''),
      z
        .string()
        .trim()
        .max(63)
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
    ])
    .optional(),
  networkName: z.string().trim().max(128).optional(),
  extraPorts: z
    .array(
      z.object({
        hostPort: z.coerce.number().int().min(1024).max(65535),
        containerPort: z.coerce.number().int().min(1).max(65535),
        protocol: z.enum(['tcp', 'udp']),
        label: z.string().trim().max(40).optional(),
      }),
    )
    .max(20)
    .optional(),
  extraBinds: z
    .array(
      z.object({
        hostPath: z.string().trim().min(1).max(500),
        containerPath: z.string().trim().min(1).max(300),
        mode: z.enum(['rw', 'ro']).optional(),
      }),
    )
    .max(20)
    .optional(),
};

const overridesSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(4000).optional(),
  icon: z.string().max(64).optional(),
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  tags: z.array(z.string().trim().min(1).max(24)).max(16).optional(),
  mcVersion: z.string().trim().max(32).optional(),
  heapMb: z.coerce.number().int().min(512).max(262144).optional(),
  containerMemoryMb: z.coerce.number().int().min(1024).max(524288).optional(),
  cpus: z.coerce.number().min(0).max(128).optional(),
  diskQuotaGb: z.coerce.number().min(0).max(16384).optional(),
  ...dockerOverridesSchema,
});
const uploadTokenSchema = z
  .string()
  .regex(/^bpup-[A-Za-z0-9_-]{10}\.mcserver\.zip$/, 'Invalid upload token');

/**
 * Ports legacy `publicBlueprint()` — legacy's raw `dbApi` returned bare SQL
 * rows (snake_case columns) directly as JSON; `BlueprintsLibraryService`'s
 * `DecoratedBlueprint` is a Drizzle row (camelCase) instead, so this maps
 * field-by-field back to the snake_case shape the frontend actually expects,
 * rather than spreading `...row` (which would silently send `relPath` where
 * the frontend reads `rel_path`, etc.) — also drops `manifestJson`/`manifest`,
 * which must never leak to the client.
 */
function publicBlueprint(
  b: DecoratedBlueprint | null,
): BlueprintViewModel | null {
  if (!b) return null;
  return {
    id: b.id,
    name: b.name,
    filename: b.filename,
    rel_path: b.relPath,
    size_bytes: b.sizeBytes,
    builtin: b.builtin,
    created_at: b.createdAt,
    created: b.created,
    notes: b.notes,
    pack: b.pack,
    overlayCount: b.overlayCount,
    type: b.type,
    mcVersion: b.mcVersion,
    world: b.world,
  };
}
function publicServer(s: Server | null) {
  if (!s) return null;
  return {
    id: s.id,
    name: s.display_name,
    type: s.type,
    mcVersion: s.mc_version,
    portGame: s.port_game,
  };
}

/** Ports legacy `src/web/routes/blueprints.ts`, mounted at /api/blueprints. */
@Controller('api/blueprints')
export class BlueprintsController {
  constructor(
    private readonly exportService: BlueprintExportService,
    private readonly importService: BlueprintImportService,
    private readonly library: BlueprintsLibraryService,
    private readonly pathGuard: PathGuardService,
  ) {}

  @Get()
  async list() {
    return {
      ok: true,
      blueprints: (await this.library.listBlueprints()).map((b) =>
        publicBlueprint(b),
      ),
    };
  }

  @Post('export')
  async export(@Req() req: Request) {
    const input = parseBody(
      z.object({
        serverId: z.string().trim().min(1).max(40),
        includeConfig: z.coerce.boolean().optional(),
        embedFiles: z.coerce.boolean().optional(),
        includeWorld: z.coerce.boolean().optional(),
      }),
      req.body,
    );
    const row = await this.exportService.exportBlueprint(
      input.serverId,
      {
        includeConfig: input.includeConfig !== false,
        embedFiles: input.embedFiles,
        includeWorld: input.includeWorld,
      },
      { actor: req.user!.username },
    );
    return {
      ok: true,
      blueprint: publicBlueprint(
        await this.library.getBlueprint(String(row.id)),
      ),
    };
  }

  @Post('import-preview')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, os.tmpdir()),
        filename: (_req, _file, cb) =>
          cb(null, `bpup-${nanoid(10)}.mcserver.zip`),
      }),
      limits: { fileSize: 8 * 1024 ** 3 },
    }),
  )
  async importPreview(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: Request,
  ) {
    if (file) {
      let preview;
      try {
        preview = await this.importService.importPreview(file.path);
      } catch (err) {
        await fsp.rm(file.path, { force: true }).catch(() => {});
        throw err;
      }
      return { ok: true, preview, uploadToken: file.filename };
    }
    const { blueprintId } = parseBody(
      z.object({ blueprintId: z.string().trim().min(1).max(40) }),
      req.body || {},
    );
    const preview = await this.importService.importPreview(
      await this.library.getBlueprintPath(blueprintId),
    );
    return { ok: true, preview, blueprintId };
  }

  @Post('import')
  async import(@Req() req: Request) {
    const input = parseBody(
      z
        .object({
          blueprintId: z.string().trim().min(1).max(40).optional(),
          uploadToken: uploadTokenSchema.optional(),
          overrides: overridesSchema.optional(),
        })
        .refine((v) => Boolean(v.blueprintId) !== Boolean(v.uploadToken), {
          message: 'Provide exactly one of blueprintId or uploadToken',
        }),
      req.body,
    );

    let zipRef = input.blueprintId;
    if (input.uploadToken) {
      zipRef = this.pathGuard.dataPath('tmp', input.uploadToken);
      if (!fs.existsSync(zipRef))
        throw new NotFoundException(
          'Uploaded blueprint expired — upload it again',
        );
    }
    if (input.overrides) requireAdminForOverrides(req, input.overrides);
    const { server, report } = await this.importService.importBlueprint(
      zipRef as string,
      input.overrides || {},
      { actor: req.user!.username },
    );
    if (input.uploadToken)
      await fsp.rm(zipRef as string, { force: true }).catch(() => {});
    return { ok: true, server: publicServer(server), report };
  }

  @Post('clone')
  async clone(@Req() req: Request) {
    const input = parseBody(
      z.object({
        serverId: z.string().trim().min(1).max(40),
        includeWorld: z.coerce.boolean().optional(),
      }),
      req.body,
    );
    const { server, report, blueprint } = await this.importService.cloneServer(
      input.serverId,
      { includeWorld: input.includeWorld, actor: req.user!.username },
    );
    return {
      ok: true,
      server: publicServer(server),
      report,
      blueprint: publicBlueprint(await this.library.getBlueprint(blueprint.id)),
    };
  }

  @Get(':id/download')
  async download(@Param('id') id: string, @Res() res: Response) {
    const row = await this.library.getBlueprint(id);
    if (!row) throw new NotFoundException('Blueprint not found');
    res.download(this.pathGuard.dataPath(row.relPath), row.filename);
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: Request) {
    return {
      ok: true,
      ...(await this.library.deleteBlueprint(id, {
        actor: req.user!.username,
      })),
    };
  }
}
