import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import * as fsp from 'node:fs/promises';
import { z } from 'zod';
import { parseBody } from '../utils/parse-body';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { FilesService } from './files.service';
import { UploadPreflightInterceptor } from './upload-preflight.interceptor';

const pathSchema = z.string().max(4096).default('');
const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .regex(/^[^\\/\0]+$/, 'Names cannot contain path separators');

/** Global (admin) file manager, rooted at DATA_DIR. Ports the `globalFiles` branch of legacy `src/web/routes/files.ts`. */
@Controller('api/files')
@UseGuards(RolesGuard)
@Roles('admin')
export class GlobalFilesController {
  constructor(private readonly files: FilesService) {}

  @Get('list')
  async list(@Query('path') path?: string) {
    const rel = parseBody(pathSchema, path ?? '');
    return { ok: true, ...(await this.files.list(null, rel)) };
  }

  @Get('read')
  async read(@Query('path') path?: string) {
    const rel = parseBody(pathSchema, path ?? '');
    return { ok: true, path: rel, ...(await this.files.readText(null, rel)) };
  }

  @Get('download')
  async download(
    @Query('path') path: string | undefined,
    @Res() res: Response,
  ) {
    const rel = parseBody(pathSchema, path ?? '');
    const file = await this.files.statFile(null, rel);
    res.download(file.abs, file.name);
  }

  @Post('write')
  async write(@Body() body: unknown) {
    const { path: rel, content } = parseBody(
      z.object({
        path: pathSchema,
        content: z
          .string()
          .max(2 * 1024 * 1024, 'Content exceeds the 2 MB editor limit'),
      }),
      body,
    );
    return {
      ok: true,
      ...(await this.files.writeText(null, rel, content, { actor: 'system' })),
    };
  }

  @Post('mkdir')
  async mkdir(@Body() body: unknown, @Req() req: Request) {
    const { path: rel } = parseBody(z.object({ path: pathSchema }), body);
    return {
      ok: true,
      ...(await this.files.mkdir(null, rel, { actor: req.user!.username })),
    };
  }

  @Post('rename')
  async rename(@Body() body: unknown, @Req() req: Request) {
    const { path: rel, newName } = parseBody(
      z.object({ path: pathSchema, newName: nameSchema }),
      body,
    );
    return {
      ok: true,
      ...(await this.files.rename(null, rel, newName, {
        actor: req.user!.username,
      })),
    };
  }

  @Post('move')
  async move(@Body() body: unknown, @Req() req: Request) {
    const { path: rel, dest } = parseBody(
      z.object({ path: pathSchema, dest: pathSchema }),
      body,
    );
    return {
      ok: true,
      ...(await this.files.move(null, rel, dest, {
        actor: req.user!.username,
      })),
    };
  }

  @Post('copy')
  async copy(@Body() body: unknown, @Req() req: Request) {
    const { path: rel, dest } = parseBody(
      z.object({ path: pathSchema, dest: pathSchema }),
      body,
    );
    return {
      ok: true,
      ...(await this.files.copy(null, rel, dest, {
        actor: req.user!.username,
      })),
    };
  }

  @Delete()
  async remove(@Query('path') path: string | undefined, @Req() req: Request) {
    const rel = parseBody(pathSchema, path ?? '');
    return {
      ok: true,
      ...(await this.files.remove(null, rel, { actor: req.user!.username })),
    };
  }

  @Post('upload')
  @UseInterceptors(UploadPreflightInterceptor, FilesInterceptor('files', 20))
  async upload(
    @Query('path') path: string | undefined,
    @UploadedFiles() uploadedFiles: Express.Multer.File[] | undefined,
    @Req() req: Request,
  ) {
    try {
      const rel = parseBody(pathSchema, path ?? '');
      if (!uploadedFiles || !uploadedFiles.length)
        throw new BadRequestException('No files attached');
      const uploaded = [];
      for (const f of uploadedFiles) {
        uploaded.push(
          await this.files.acceptUpload(null, rel, f.path, f.originalname, {
            actor: req.user!.username,
          }),
        );
      }
      return { ok: true, uploaded };
    } catch (err) {
      if (uploadedFiles) {
        for (const f of uploadedFiles)
          await fsp.rm(f.path, { force: true }).catch(() => {});
      }
      throw err;
    }
  }
}
