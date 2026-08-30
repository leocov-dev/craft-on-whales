import {
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import archiver from 'archiver';
import { z } from 'zod';
import { parseBody } from '../utils/parse-body';
import { PathGuardService } from '../storage/path-guard.service';
import { CrashesService, type DecoratedCrash } from './crashes.service';
import { crashAbsPathFor } from './crash-paths';
import type { CrashReport } from '../../../shared/types/crashes';

/**
 * Legacy's raw `dbApi` returned bare SQL rows (snake_case) directly as JSON;
 * `CrashesService`'s `DecoratedCrash` is a Drizzle row (camelCase) instead,
 * so this maps field-by-field back to the snake_case shape the frontend
 * expects — spreading `...row` would silently send `serverId` where the
 * frontend reads `server_id`, etc. `viewed` is coerced back to 0/1 (Drizzle
 * gives a real boolean; legacy's raw SQLite integer was never cast).
 */
function publicCrash(row: DecoratedCrash): CrashReport {
  return {
    id: row.id,
    server_id: row.serverId,
    filename: row.filename,
    file_mtime: row.fileMtime,
    size_bytes: row.sizeBytes,
    summary: row.summary,
    exception: row.exception,
    suspected_json: row.suspectedJson,
    suspected: row.suspected,
    event_id: row.eventId,
    viewed: row.viewed ? 1 : 0,
    created_at: row.createdAt,
  };
}

const serverIdSchema = z.string().regex(/^srv_[\w-]+$/, 'Invalid server id');
const crashIdSchema = z
  .string()
  .regex(/^cr_[\w-]+$/, 'Invalid crash report id');

/** Crash-report API. Ports `src/web/routes/crashes.ts` (mounted at /api/servers/:id/crashes). */
@Controller('api/servers/:id/crashes')
export class CrashesController {
  constructor(
    private readonly crashes: CrashesService,
    private readonly pathGuard: PathGuardService,
  ) {}

  private absPathFor(serverId: string, filename: string): string {
    return crashAbsPathFor(this.pathGuard, serverId, filename);
  }

  private async ownedCrash(id: string, crashId: string) {
    const serverId = parseBody(serverIdSchema, id);
    const cid = parseBody(crashIdSchema, crashId);
    const row = await this.crashes.getCrash(cid);
    if (!row || row.serverId !== serverId)
      throw new NotFoundException('Crash report not found');
    return row;
  }

  @Get()
  async list(@Param('id') id: string) {
    const serverId = parseBody(serverIdSchema, id);
    await this.crashes.scanServer(serverId).catch(() => {});
    return {
      ok: true,
      crashes: (await this.crashes.listCrashes(serverId)).map(publicCrash),
    };
  }

  // Must be declared before /:crashId routes (matches legacy ordering).
  @Get('export.zip')
  async exportZip(@Param('id') id: string, @Res() res: Response) {
    const serverId = parseBody(serverIdSchema, id);
    const rows = await this.crashes.listCrashes(serverId);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="crash-reports-${serverId}.zip"`,
    );

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err: Error) => res.destroy(err));
    archive.pipe(res);
    for (const row of rows) {
      const abs = this.absPathFor(serverId, row.filename);
      if (fs.existsSync(abs))
        archive.file(abs, { name: path.basename(row.filename) });
    }
    archive.finalize();
  }

  @Delete()
  async deleteOlderThan(
    @Param('id') id: string,
    @Query('olderThanDays') olderThanDays: string,
    @Req() req: Request,
  ) {
    const serverId = parseBody(serverIdSchema, id);
    const days = parseBody(
      z.coerce.number().int().min(1).max(3650),
      olderThanDays,
    );
    return {
      ok: true,
      ...(await this.crashes.deleteOlderThan(serverId, days, {
        actor: req.user?.username,
      })),
    };
  }

  @Get(':crashId/text')
  async text(
    @Param('id') id: string,
    @Param('crashId') crashId: string,
    @Res() res: Response,
  ) {
    const row = await this.ownedCrash(id, crashId);
    const text = await this.crashes.getCrashText(row.serverId, row.filename);
    await this.crashes.markViewed(row.id);
    res.type('text/plain').send(text);
  }

  @Post(':crashId/viewed')
  async markViewed(@Param('id') id: string, @Param('crashId') crashId: string) {
    await this.crashes.markViewed((await this.ownedCrash(id, crashId)).id);
    return { ok: true };
  }

  @Delete(':crashId')
  async deleteOne(
    @Param('id') id: string,
    @Param('crashId') crashId: string,
    @Req() req: Request,
  ) {
    const row = await this.ownedCrash(id, crashId);
    const { freedBytes } = await this.crashes.deleteCrash(row.id, {
      actor: req.user?.username,
    });
    return { ok: true, freedBytes };
  }
}
