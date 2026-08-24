import {
  BadRequestException,
  Body,
  Controller,
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
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { z, ZodError } from 'zod';
import { and, eq, like, or, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { ConfigService } from '../config/config.service';
import { events, servers } from '../db/schema';
import { EventsService } from '../events/events.service';
import type { EventViewModel } from '../../../shared/types/events';

const ACTIVITY_PER_PAGE = 50;

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

/** Ports the "Events" section of legacy `src/web/routes/api.ts`. */
@Controller('api')
export class EventsController {
  constructor(
    private readonly dbService: DbService,
    private readonly config: ConfigService,
    private readonly eventsService: EventsService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  @Get('events')
  async list(
    @Query('q') q = '',
    @Query('server') server = '',
    @Query('type') type = '',
    @Query('page') pageQ = '',
  ) {
    const qq = q.trim().slice(0, 200);
    const serverId = server.trim().slice(0, 40);
    const eventType = type.trim().slice(0, 60);
    const where = [
      ...(serverId ? [eq(events.serverId, serverId)] : []),
      ...(eventType ? [eq(events.type, eventType)] : []),
      ...(qq
        ? [
            or(
              like(events.summary, `%${qq}%`),
              like(events.actor, `%${qq}%`),
              like(events.type, `%${qq}%`),
            )!,
          ]
        : []),
    ];
    const whereClause = where.length ? and(...where) : undefined;
    const [totalRow] = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(events)
      .where(whereClause)
      .limit(1);
    const total = totalRow?.n || 0;
    const pages = Math.max(1, Math.ceil(total / ACTIVITY_PER_PAGE));
    const page = Math.min(pages, Math.max(1, parseInt(pageQ, 10) || 1));
    const rows = await this.db
      .select()
      .from(events)
      .where(whereClause)
      .orderBy(sql`id desc`)
      .limit(ACTIVITY_PER_PAGE)
      .offset((page - 1) * ACTIVITY_PER_PAGE);
    const list = await Promise.all(
      rows.map((r) =>
        this.eventVM({ ...r, details: safeJsonParse(r.detailsJson) }),
      ),
    );
    const typeRows = await this.db
      .selectDistinct({ type: events.type })
      .from(events)
      .orderBy(events.type);
    const types = typeRows.map((r) => r.type);
    return {
      ok: true,
      events: list,
      types,
      filters: { q: qq, server: serverId, type: eventType },
      total,
      page,
      pages,
      perPage: ACTIVITY_PER_PAGE,
    };
  }

  private async eventVM(e: {
    id: number;
    serverId: string | null;
    actor: string;
    type: string;
    summary: string;
    logExcerptPath: string | null;
    createdAt: string;
    details: Record<string, unknown>;
  }): Promise<EventViewModel> {
    const row = e.serverId
      ? (
          await this.db
            .select({
              displayName: servers.displayName,
              deletedAt: servers.deletedAt,
            })
            .from(servers)
            .where(eq(servers.id, e.serverId))
            .limit(1)
        )[0]
      : null;
    return {
      id: e.id,
      serverId: row && !row.deletedAt ? e.serverId : null,
      server: row
        ? row.displayName + (row.deletedAt ? ' (deleted)' : '')
        : '— panel —',
      type: e.type,
      actor: e.actor,
      ts: e.createdAt,
      summary: e.summary,
      hasLog: Boolean(e.logExcerptPath),
      diff: (e.details as { diff?: unknown })?.diff ?? null,
    };
  }

  @Get('events/export')
  async export(
    @Req() req: Request,
    @Res() res: Response,
    @Query('server') server = '',
    @Query('q') q = '',
    @Query('type') type = '',
    @Query('format') format = 'json',
  ) {
    const { filename, contentType, body } =
      await this.eventsService.exportEvents(server || null, {
        format: format === 'csv' ? 'csv' : 'json',
        q: q.trim(),
        type: type.trim(),
      });
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.type(contentType).send(body);
  }

  @Get('servers/:id/events/export')
  async exportForServer(
    @Res() res: Response,
    @Param('id') id: string,
    @Query('q') q = '',
    @Query('type') type = '',
    @Query('format') format = 'json',
  ) {
    const { filename, contentType, body } =
      await this.eventsService.exportEvents(id, {
        format: format === 'csv' ? 'csv' : 'json',
        q: q.trim(),
        type: type.trim(),
      });
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.type(contentType).send(body);
  }

  @Get('events/:id/excerpt')
  async excerpt(@Res() res: Response, @Param('id') id: string) {
    const event = await this.eventsService.getEvent(Number(id));
    if (!event) throw new NotFoundException('Event not found');
    const text = this.eventsService.readExcerpt(event);
    if (text == null)
      throw new NotFoundException('No captured log for this event');
    res.type('text/plain').send(text);
  }

  @Post('events/prune')
  async prune(@Req() req: Request, @Body() body: unknown) {
    const { days } = parseBody(
      z.object({ days: z.coerce.number().int().min(1).max(3650) }),
      body,
    );
    const { removed } = await this.eventsService.pruneEvents(days, {
      actor: req.user!.username,
    });
    return { ok: true, removed };
  }

  @Get('servers/:id/logs/archived')
  async archivedList(@Param('id') id: string) {
    const dir = path.join(this.config.dataDir, 'logs', id, 'events');
    const entries = await fsp
      .readdir(dir, { withFileTypes: true })
      .catch(() => []);
    const files: { file: string; size: number; mtimeMs: number }[] = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const st = await fsp.stat(path.join(dir, e.name)).catch(() => null);
      if (!st) continue;
      files.push({ file: e.name, size: st.size, mtimeMs: st.mtimeMs });
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { ok: true, files };
  }

  @Get('servers/:id/logs/archived/:file')
  archivedFile(
    @Res() res: Response,
    @Param('id') id: string,
    @Param('file') fileParam: string,
  ) {
    const file = parseBody(
      z.string().regex(/^[\w.,()[\] -]+$/, 'Invalid file name'),
      fileParam,
    );
    const abs = path.join(this.config.dataDir, 'logs', id, 'events', file);
    if (!fs.existsSync(abs))
      throw new NotFoundException('Archived log not found');
    res.download(abs, file);
  }
}

function safeJsonParse(
  json: string | null | undefined,
): Record<string, unknown> {
  try {
    return JSON.parse(json || '{}');
  } catch {
    return {};
  }
}
