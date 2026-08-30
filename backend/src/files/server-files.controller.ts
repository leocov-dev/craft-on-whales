import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
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
import { ServerQueryService } from '../servers/server-query.service';
import { FilesService } from './files.service';
import { UploadPreflightInterceptor } from './upload-preflight.interceptor';
import { currentUser } from '../auth/current-user';

const pathSchema = z.string().max(4096).default('');
const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .regex(/^[^\\/\0]+$/, 'Names cannot contain path separators');

/** Server-scoped file manager. Ports the `serverFiles` branch of legacy `src/web/routes/files.ts`. */
@Controller('api/servers/:id/files')
@UseGuards(RolesGuard)
@Roles('admin', 'operator')
export class ServerFilesController {
  constructor(
    private readonly files: FilesService,
    private readonly serverQuery: ServerQueryService,
  ) {}

  private async mustExist(id: string): Promise<void> {
    if (!(await this.serverQuery.getServer(id)))
      throw new NotFoundException('Server not found');
  }

  @Get('list')
  async list(@Param('id') id: string, @Query('path') path?: string) {
    await this.mustExist(id);
    const rel = parseBody(pathSchema, path ?? '');
    return { ok: true, ...(await this.files.list(id, rel)) };
  }

  @Get('read')
  async read(@Param('id') id: string, @Query('path') path?: string) {
    await this.mustExist(id);
    const rel = parseBody(pathSchema, path ?? '');
    return { ok: true, path: rel, ...(await this.files.readText(id, rel)) };
  }

  @Get('download')
  async download(
    @Param('id') id: string,
    @Query('path') path: string | undefined,
    @Res() res: Response,
  ) {
    await this.mustExist(id);
    const rel = parseBody(pathSchema, path ?? '');
    const file = await this.files.statFile(id, rel);
    res.download(file.abs, file.name);
  }

  @Post('write')
  async write(@Param('id') id: string, @Body() body: unknown) {
    await this.mustExist(id);
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
      ...(await this.files.writeText(id, rel, content, { actor: 'system' })),
    };
  }

  @Post('mkdir')
  async mkdir(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    await this.mustExist(id);
    const { path: rel } = parseBody(z.object({ path: pathSchema }), body);
    return {
      ok: true,
      ...(await this.files.mkdir(id, rel, {
        actor: currentUser(req).username,
      })),
    };
  }

  @Post('rename')
  async rename(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    await this.mustExist(id);
    const { path: rel, newName } = parseBody(
      z.object({ path: pathSchema, newName: nameSchema }),
      body,
    );
    return {
      ok: true,
      ...(await this.files.rename(id, rel, newName, {
        actor: currentUser(req).username,
      })),
    };
  }

  @Post('move')
  async move(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    await this.mustExist(id);
    const { path: rel, dest } = parseBody(
      z.object({ path: pathSchema, dest: pathSchema }),
      body,
    );
    return {
      ok: true,
      ...(await this.files.move(id, rel, dest, {
        actor: currentUser(req).username,
      })),
    };
  }

  @Post('copy')
  async copy(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    await this.mustExist(id);
    const { path: rel, dest } = parseBody(
      z.object({ path: pathSchema, dest: pathSchema }),
      body,
    );
    return {
      ok: true,
      ...(await this.files.copy(id, rel, dest, {
        actor: currentUser(req).username,
      })),
    };
  }

  @Delete()
  async remove(
    @Param('id') id: string,
    @Query('path') path: string | undefined,
    @Req() req: Request,
  ) {
    await this.mustExist(id);
    const rel = parseBody(pathSchema, path ?? '');
    return {
      ok: true,
      ...(await this.files.remove(id, rel, {
        actor: currentUser(req).username,
      })),
    };
  }

  @Post('upload')
  @UseInterceptors(UploadPreflightInterceptor, FilesInterceptor('files', 20))
  async upload(
    @Param('id') id: string,
    @Query('path') path: string | undefined,
    @UploadedFiles() uploadedFiles: Express.Multer.File[] | undefined,
    @Req() req: Request,
  ) {
    await this.mustExist(id);
    try {
      const rel = parseBody(pathSchema, path ?? '');
      if (!uploadedFiles || !uploadedFiles.length)
        throw new BadRequestException('No files attached');
      const uploaded = [];
      for (const f of uploadedFiles) {
        uploaded.push(
          await this.files.acceptUpload(id, rel, f.path, f.originalname, {
            actor: currentUser(req).username,
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
