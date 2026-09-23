import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { ConfigService } from '../config/config.service';
import { backups, servers } from '../db/schema';
import { BackupsService } from '../worlds/backups.service';
import { ServerQueryService } from '../servers/server-query.service';
import { TasksService } from '../tasks/tasks.service';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { parseBody } from '../utils/parse-body';
import type { BackupRow, ServerBackupRow } from '../../../shared/types/backups';
import { currentUser } from '../auth/current-user';
import { ServerPermissionGuard } from '../permissions/server-permission.guard';
import { RequireServerPermission } from '../permissions/require-server-permission.decorator';
import { PermissionsService } from '../permissions/permissions.service';

/** Server id behind a backup id, for the `/backups/:backupId` routes. */
async function backupServerId(
  req: Request,
  { db }: { db: DbService },
): Promise<string | null> {
  const backupId = req.params?.backupId;
  if (typeof backupId !== 'string') return null;
  const [row] = await db.db
    .select({ serverId: backups.serverId })
    .from(backups)
    .where(eq(backups.id, backupId))
    .limit(1);
  return row ? row.serverId : null;
}

const createSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

const renameSchema = z.object({
  name: z.string().trim().max(120),
});

/** Ports the "Backups" section of legacy `src/web/routes/api.ts`. */
@Controller('api')
export class BackupsController {
  constructor(
    private readonly dbService: DbService,
    private readonly config: ConfigService,
    private readonly backupsService: BackupsService,
    private readonly serverQuery: ServerQueryService,
    private readonly tasks: TasksService,
    private readonly permissions: PermissionsService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  @Get('servers/:id/backups')
  @UseGuards(ServerPermissionGuard)
  @RequireServerPermission('view')
  async listForServer(
    @Param('id') id: string,
  ): Promise<{ ok: true; backups: ServerBackupRow[] }> {
    await this.serverQuery.mustGet(id);
    const rows = await this.db
      .select()
      .from(backups)
      .where(eq(backups.serverId, id))
      .orderBy(desc(backups.createdAt));
    return {
      ok: true,
      backups: rows.map((b) => ({
        id: b.id,
        file: b.filename,
        customName: b.customName,
        size: b.sizeBytes,
        reason: b.reason,
        ts: b.createdAt,
      })),
    };
  }

  @Get('backups')
  async listAll(@Req() req: Request): Promise<{
    ok: true;
    backups: BackupRow[];
    totals: { count: number; bytes: number };
  }> {
    const rows = await this.db
      .select({
        id: backups.id,
        serverId: backups.serverId,
        displayName: servers.displayName,
        filename: backups.filename,
        customName: backups.customName,
        sizeBytes: backups.sizeBytes,
        reason: backups.reason,
        createdAt: backups.createdAt,
      })
      .from(backups)
      .innerJoin(servers, eq(servers.id, backups.serverId))
      .orderBy(desc(backups.createdAt));
    const visibleIds = await this.permissions.visibleServerIds(req.user);
    const visibleRows =
      req.user?.role === 'admin'
        ? rows
        : rows.filter((r) => visibleIds.has(r.serverId));
    const list = visibleRows.map((b) => ({
      id: b.id,
      serverId: b.serverId,
      server: b.displayName,
      file: b.filename,
      customName: b.customName,
      size: b.sizeBytes,
      reason: b.reason,
      ts: b.createdAt,
    }));
    return {
      ok: true,
      backups: list,
      totals: {
        count: list.length,
        bytes: list.reduce((n, b) => n + b.size, 0),
      },
    };
  }

  @Post('servers/:id/backups')
  @HttpCode(202)
  @UseGuards(ServerPermissionGuard)
  @RequireServerPermission('backups')
  async create(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const server = await this.serverQuery.mustGet(id);
    const actor = currentUser(req).username;
    const { note = '' } = parseBody(createSchema, body ?? {});
    const taskId = this.tasks.run(
      `Backing up ${server.display_name}`,
      { serverId: server.id, actor },
      async (t) => {
        t.step(
          'Snapshotting server directory (save-off → save-all → zip → save-on)',
        );
        const backup = await this.backupsService.createBackup(server.id, {
          reason: 'manual',
          actor,
          note,
        });
        return {
          id: backup.id,
          filename: backup.filename,
          size: backup.sizeBytes,
        };
      },
    );
    return { ok: true, taskId };
  }

  @Post('servers/:id/backups/:backupId/restore')
  @HttpCode(202)
  @UseGuards(ServerPermissionGuard)
  @RequireServerPermission('backups')
  async restore(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('backupId') backupId: string,
  ) {
    const server = await this.serverQuery.mustGet(id);
    const actor = currentUser(req).username;
    const taskId = this.tasks.run(
      `Restoring backup on ${server.display_name}`,
      { serverId: server.id, actor },
      async (t) => {
        t.step('Stopping server & taking a safety backup');
        await this.backupsService.restoreBackup(server.id, backupId, { actor });
        return { ok: true };
      },
    );
    return { ok: true, taskId };
  }

  @Get('backups/:backupId/download')
  @UseGuards(RolesGuard, ServerPermissionGuard)
  @Roles('admin', 'operator')
  @RequireServerPermission('backups', backupServerId)
  async download(@Res() res: Response, @Param('backupId') backupId: string) {
    const [backup] = await this.db
      .select()
      .from(backups)
      .where(eq(backups.id, backupId))
      .limit(1);
    if (!backup) throw new NotFoundException('Backup not found');
    const abs = path.join(this.config.dataDir, backup.relPath);
    if (!fs.existsSync(abs))
      throw new NotFoundException('Backup archive is missing on disk');
    res.download(abs, backup.filename);
  }

  @Patch('backups/:backupId')
  @UseGuards(ServerPermissionGuard)
  @RequireServerPermission('backups', backupServerId)
  async rename(
    @Req() req: Request,
    @Param('backupId') backupId: string,
    @Body() body: unknown,
  ): Promise<{ ok: true; backup: { id: string; customName: string | null } }> {
    const { name } = parseBody(renameSchema, body);
    const updated = await this.backupsService.renameBackup(backupId, name, {
      actor: currentUser(req).username,
    });
    return {
      ok: true,
      backup: { id: updated.id, customName: updated.customName },
    };
  }

  @Delete('backups/:backupId')
  @UseGuards(ServerPermissionGuard)
  @RequireServerPermission('backups', backupServerId)
  async remove(@Req() req: Request, @Param('backupId') backupId: string) {
    const result = await this.backupsService.deleteBackup(backupId, {
      actor: currentUser(req).username,
    });
    return { ok: true, ...result };
  }
}
