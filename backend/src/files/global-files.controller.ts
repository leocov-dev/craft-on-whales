import {
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
  Body,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UploadPreflightInterceptor } from './upload-preflight.interceptor';
import { FilesRouteHandlersService } from './files-route-handlers.service';

/** Global (admin) file manager, rooted at DATA_DIR. Ports the `globalFiles` branch of legacy `src/web/routes/files.ts`. */
@Controller('api/files')
@UseGuards(RolesGuard)
@Roles('admin')
export class GlobalFilesController {
  constructor(private readonly handlers: FilesRouteHandlersService) {}

  @Get('list')
  list(@Query('path') path?: string) {
    return this.handlers.list(null, path);
  }

  @Get('read')
  read(@Query('path') path?: string) {
    return this.handlers.read(null, path);
  }

  @Get('download')
  download(@Query('path') path: string | undefined, @Res() res: Response) {
    return this.handlers.download(null, path, res);
  }

  @Post('write')
  write(@Body() body: unknown) {
    return this.handlers.write(null, body);
  }

  @Post('mkdir')
  mkdir(@Body() body: unknown, @Req() req: Request) {
    return this.handlers.mkdir(null, body, req);
  }

  @Post('rename')
  rename(@Body() body: unknown, @Req() req: Request) {
    return this.handlers.rename(null, body, req);
  }

  @Post('move')
  move(@Body() body: unknown, @Req() req: Request) {
    return this.handlers.move(null, body, req);
  }

  @Post('copy')
  copy(@Body() body: unknown, @Req() req: Request) {
    return this.handlers.copy(null, body, req);
  }

  @Delete()
  remove(@Query('path') path: string | undefined, @Req() req: Request) {
    return this.handlers.remove(null, path, req);
  }

  @Post('upload')
  @UseInterceptors(UploadPreflightInterceptor, FilesInterceptor('files', 20))
  upload(
    @Query('path') path: string | undefined,
    @UploadedFiles() uploadedFiles: Express.Multer.File[] | undefined,
    @Req() req: Request,
  ) {
    return this.handlers.upload(null, path, uploadedFiles, req);
  }
}
