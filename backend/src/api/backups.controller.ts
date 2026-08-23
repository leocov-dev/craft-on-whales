import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { desc, eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { ConfigService } from '../config/config.service';
import { backups, servers } from '../db/schema';
import { BackupsService } from '../worlds/backups.service';
import { ServerQueryService } from '../servers/server-query.service';
import { TasksService } from '../tasks/tasks.service';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { BackupRow, ServerBackupRow } from '../../../shared/types/backups';

/** Ports the "Backups" section of legacy `src/web/routes/api.ts`. */
@Controller('api')
export class BackupsController {
  constructor(
    private readonly dbService: DbService,
    private readonly config: ConfigService,
    private readonly backupsService: BackupsService,
    private readonly serverQuery: ServerQueryService,
    private readonly tasks: TasksService
  ) {}

  private get db() {
    return this.dbService.db;
  }

  @Get('servers/:id/backups')
  async listForServer(@Param('id') id: string): Promise<{ ok: true; backups: ServerBackupRow[] }> {
    await this.serverQuery.mustGet(id);
    const rows = await this.db.select().from(backups).where(eq(backups.serverId, id)).orderBy(desc(backups.createdAt));
    return { ok: true, backups: rows.map((b) => ({ id: b.id, file: b.filename, size: b.sizeBytes, reason: b.reason, ts: b.createdAt })) };
  }

  @Get('backups')
  async listAll(): Promise<{ ok: true; backups: BackupRow[]; totals: { count: number; bytes: number } }> {
    const rows = await this.db
      .select({ id: backups.id, serverId: backups.serverId, displayName: servers.displayName, filename: backups.filename, sizeBytes: backups.sizeBytes, reason: backups.reason, createdAt: backups.createdAt })
      .from(backups)
      .innerJoin(servers, eq(servers.id, backups.serverId))
      .orderBy(desc(backups.createdAt));
    const list = rows.map((b) => ({ id: b.id, serverId: b.serverId, server: b.displayName, file: b.filename, size: b.sizeBytes, reason: b.reason, ts: b.createdAt }));
    return { ok: true, backups: list, totals: { count: list.length, bytes: list.reduce((n, b) => n + b.size, 0) } };
  }

  @Post('servers/:id/backups')
  @HttpCode(202)
  async create(@Req() req: Request, @Param('id') id: string, @Body() body: { note?: string } = {}) {
    const server = await this.serverQuery.mustGet(id);
    const actor = req.user!.username;
    const note = String(body?.note || '');
    const taskId = this.tasks.run(`Backing up ${server.display_name}`, { serverId: server.id, actor }, async (t) => {
      t.step('Snapshotting server directory (save-off → save-all → zip → save-on)');
      const backup = await this.backupsService.createBackup(server.id, { reason: 'manual', actor, note });
      return { id: backup.id, filename: backup.filename, size: backup.sizeBytes };
    });
    return { ok: true, taskId };
  }

  @Post('servers/:id/backups/:backupId/restore')
  @HttpCode(202)
  async restore(@Req() req: Request, @Param('id') id: string, @Param('backupId') backupId: string) {
    const server = await this.serverQuery.mustGet(id);
    const actor = req.user!.username;
    const taskId = this.tasks.run(`Restoring backup on ${server.display_name}`, { serverId: server.id, actor }, async (t) => {
      t.step('Stopping server & taking a safety backup');
      await this.backupsService.restoreBackup(server.id, backupId, { actor });
      return { ok: true };
    });
    return { ok: true, taskId };
  }

  @Get('backups/:backupId/download')
  @UseGuards(RolesGuard)
  @Roles('admin', 'operator')
  async download(@Res() res: Response, @Param('backupId') backupId: string) {
    const [backup] = await this.db.select().from(backups).where(eq(backups.id, backupId)).limit(1);
    if (!backup) throw new NotFoundException('Backup not found');
    const abs = path.join(this.config.dataDir, backup.relPath);
    if (!fs.existsSync(abs)) throw new NotFoundException('Backup archive is missing on disk');
    res.download(abs, backup.filename);
  }

  @Delete('backups/:backupId')
  async remove(@Req() req: Request, @Param('backupId') backupId: string) {
    const result = await this.backupsService.deleteBackup(backupId, { actor: req.user!.username });
    return { ok: true, ...result };
  }
}
