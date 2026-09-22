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
  UploadedFiles,
  UseGuards,
  UseInterceptors,
  Body,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ServerQueryService } from '../servers/server-query.service';
import { UploadPreflightInterceptor } from './upload-preflight.interceptor';
import { FilesRouteHandlersService } from './files-route-handlers.service';
import { ServerPermissionGuard } from '../permissions/server-permission.guard';
import { RequireServerPermission } from '../permissions/require-server-permission.decorator';

/** Server-scoped file manager. Ports the `serverFiles` branch of legacy `src/web/routes/files.ts`. */
@Controller('api/servers/:id/files')
@UseGuards(RolesGuard)
@Roles('admin', 'operator')
@UseGuards(ServerPermissionGuard)
export class ServerFilesController {
  constructor(
    private readonly handlers: FilesRouteHandlersService,
    private readonly serverQuery: ServerQueryService,
  ) {}

  private async mustExist(id: string): Promise<void> {
    if (!(await this.serverQuery.getServer(id)))
      throw new NotFoundException('Server not found');
  }

  @RequireServerPermission('files')
  @Get('list')
  async list(@Param('id') id: string, @Query('path') path?: string) {
    await this.mustExist(id);
    return this.handlers.list(id, path);
  }

  @RequireServerPermission('files')
  @Get('read')
  async read(@Param('id') id: string, @Query('path') path?: string) {
    await this.mustExist(id);
    return this.handlers.read(id, path);
  }

  @RequireServerPermission('files')
  @Get('download')
  async download(
    @Param('id') id: string,
    @Query('path') path: string | undefined,
    @Res() res: Response,
  ) {
    await this.mustExist(id);
    return this.handlers.download(id, path, res);
  }

  @RequireServerPermission('files')
  @Post('write')
  async write(@Param('id') id: string, @Body() body: unknown) {
    await this.mustExist(id);
    return this.handlers.write(id, body);
  }

  @RequireServerPermission('files')
  @Post('mkdir')
  async mkdir(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    await this.mustExist(id);
    return this.handlers.mkdir(id, body, req);
  }

  @RequireServerPermission('files')
  @Post('rename')
  async rename(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    await this.mustExist(id);
    return this.handlers.rename(id, body, req);
  }

  @RequireServerPermission('files')
  @Post('move')
  async move(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    await this.mustExist(id);
    return this.handlers.move(id, body, req);
  }

  @RequireServerPermission('files')
  @Post('copy')
  async copy(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    await this.mustExist(id);
    return this.handlers.copy(id, body, req);
  }

  @RequireServerPermission('files')
  @Delete()
  async remove(
    @Param('id') id: string,
    @Query('path') path: string | undefined,
    @Req() req: Request,
  ) {
    await this.mustExist(id);
    return this.handlers.remove(id, path, req);
  }

  @RequireServerPermission('files')
  @Post('upload')
  @UseInterceptors(UploadPreflightInterceptor, FilesInterceptor('files', 20))
  async upload(
    @Param('id') id: string,
    @Query('path') path: string | undefined,
    @UploadedFiles() uploadedFiles: Express.Multer.File[] | undefined,
    @Req() req: Request,
  ) {
    await this.mustExist(id);
    return this.handlers.upload(id, path, uploadedFiles, req);
  }
}
