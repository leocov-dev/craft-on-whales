import {
  BadRequestException,
  Controller,
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
import type { Express, Request, Response } from 'express';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { DbService } from '../db/db.service';
import { servers } from '../db/schema';
import { eq } from 'drizzle-orm';
import { ServerQueryService } from '../servers/server-query.service';
import { ConfigService } from '../config/config.service';
import { EventsService } from '../events/events.service';

const ICON_MAX_BYTES = 512 * 1024;
const ICON_EXTS: Record<string, string> = {
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/jpeg': '.jpg',
};

/**
 * Server icon upload/serving, split out of `ServersController` (see
 * `.plan/reviews/02-api-servers.md` finding #7).
 */
@Controller('api')
export class IconsController {
  constructor(
    private readonly dbService: DbService,
    private readonly query: ServerQueryService,
    private readonly config: ConfigService,
    private readonly events: EventsService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  // multipart field: 'icon'. Stores <dataDir>/library/icons/custom/<serverId><ext>
  // and sets servers.icon = 'custom:<filename>' (served via GET /api/icons/custom/:file).
  @Post('servers/:id/icon')
  @UseInterceptors(
    FileInterceptor('icon', { limits: { fileSize: ICON_MAX_BYTES, files: 1 } }),
  )
  async uploadIcon(
    @Req() req: Request,
    @Param('id') id: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const server = await this.query.mustGet(id);
    try {
      if (!file)
        throw new BadRequestException('Attach an image (field "icon")');
      const ext = ICON_EXTS[file.mimetype];
      if (!ext)
        throw new BadRequestException(
          'Icons must be PNG, SVG or JPEG (max 512 KB)',
        );
      const filename = `${server.id}${ext}`;
      const destDir = path.join(
        this.config.dataDir,
        'library',
        'icons',
        'custom',
      );
      await fsp.mkdir(destDir, { recursive: true });
      // Drop stale variants with a different extension.
      for (const other of Object.values(ICON_EXTS)) {
        if (other !== ext)
          await fsp
            .rm(path.join(destDir, `${server.id}${other}`), { force: true })
            .catch(() => {});
      }
      await fsp
        .rm(path.join(destDir, filename), { force: true })
        .catch(() => {});
      await fsp
        .rename(file.path, path.join(destDir, filename))
        .catch(async () => {
          await fsp.copyFile(file.path, path.join(destDir, filename));
          await fsp.rm(file.path, { force: true });
        });
      await this.db
        .update(servers)
        .set({ icon: `custom:${filename}` })
        .where(eq(servers.id, server.id));
      this.events.recordEvent({
        serverId: server.id,
        actor: req.user!.username,
        type: 'config-changed',
        summary: 'Custom server icon uploaded',
      });
      return {
        ok: true,
        icon: `custom:${filename}`,
        url: `/api/icons/custom/${filename}`,
      };
    } catch (err) {
      if (file) await fsp.rm(file.path, { force: true }).catch(() => {});
      throw err;
    }
  }

  @Get('icons/custom/:file')
  getIcon(@Res() res: Response, @Param('file') fileParam: string) {
    const file = z
      .string()
      .regex(/^srv_[\w-]+\.(png|svg|jpg)$/, 'Invalid icon file')
      .parse(fileParam);
    const abs = path.join(
      this.config.dataDir,
      'library',
      'icons',
      'custom',
      file,
    );
    if (!fs.existsSync(abs)) throw new NotFoundException('Icon not found');
    // Custom icons may be user-uploaded SVGs (not sanitized). Serve them under a
    // locked-down, sandboxed CSP so a <script> embedded in the SVG can't execute
    // if the file is opened directly, and block content-type sniffing.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(abs);
  }
}
