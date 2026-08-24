import {
  BadRequestException,
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
import { z, ZodError } from 'zod';
import { ServerQueryService } from '../servers/server-query.service';
import { EventsService } from '../events/events.service';
import { StatusService } from '../status/status.service';
import { DiscordService } from './discord.service';
import { InvitesService } from './invites.service';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  try {
    return schema.parse(value);
  } catch (err) {
    if (err instanceof ZodError)
      throw new BadRequestException(
        err.issues[0]?.message || 'Invalid request',
      );
    throw err;
  }
}

const serverIdSchema = z.string().regex(/^srv_[\w-]+$/, 'Invalid server id');

const discordSchema = z.object({
  enabled: z.boolean(),
  webhookUrl: z
    .string()
    .trim()
    .max(400)
    .regex(
      /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//,
      'Webhook URL must start with https://discord.com/api/webhooks/',
    )
    .or(z.literal(''))
    .optional(),
  events: z
    .object({
      lifecycle: z.boolean().optional(),
      crashes: z.boolean().optional(),
      backups: z.boolean().optional(),
      updates: z.boolean().optional(),
      players: z.boolean().optional(),
    })
    .optional(),
});

const statusPageSchema = z
  .object({
    enabled: z.boolean(),
    slug: z
      .string()
      .trim()
      .regex(
        /^[a-z0-9-]{3,40}$/,
        'Slug must be 3–40 chars of lowercase letters, digits, or dashes',
      )
      .optional(),
  })
  .refine((v) => !v.enabled || v.slug, {
    message: 'A slug is required to enable the status page',
  });

/** Integrations API. Ports `src/web/routes/integrations.ts` (mounted at /api/servers/:id/integrations). */
@Controller('api/servers/:id/integrations')
export class IntegrationsController {
  constructor(
    private readonly serverQuery: ServerQueryService,
    private readonly events: EventsService,
    private readonly discord: DiscordService,
    private readonly invites: InvitesService,
    private readonly statusPage: StatusService,
  ) {}

  private async mustGet(id: string) {
    const serverId = parse(serverIdSchema, id);
    const server = await this.serverQuery.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');
    return server;
  }

  @Get()
  async get(@Param('id') id: string) {
    const server = await this.mustGet(id);
    return {
      ok: true,
      discord: await this.discord.getConfig(server.id),
      statusPage: await this.statusPage.getStatusPage(server.id),
      invite: await this.invites.inviteInfo(server.id),
    };
  }

  @Post('discord')
  async setDiscord(@Param('id') id: string, @Req() req: Request) {
    const server = await this.mustGet(id);
    const input = parse(discordSchema, req.body);
    const config = await this.discord.setConfig(server.id, input);
    this.events.recordEvent({
      serverId: server.id,
      actor: req.user ? req.user.username : 'admin',
      type: 'integration-changed',
      summary: `Discord webhook ${config.enabled ? 'enabled' : 'disabled'}${input.webhookUrl !== undefined ? ' (URL updated)' : ''}`,
    });
    return { ok: true, discord: config };
  }

  @Post('discord/test')
  async testDiscord(@Param('id') id: string) {
    const server = await this.mustGet(id);
    return this.discord.testWebhook(server.id);
  }

  @Get('invite')
  async invite(@Param('id') id: string) {
    const server = await this.mustGet(id);
    return { ok: true, invite: await this.invites.inviteInfo(server.id) };
  }

  @Get('invite/modpack.mrpack')
  async mrpack(
    @Param('id') id: string,
    @Query('host') hostQuery: string | undefined,
    @Res() res: Response,
  ) {
    const server = await this.mustGet(id);
    const host = hostQuery
      ? parse(z.string().trim().max(260), hostQuery)
      : undefined;
    const pack = await this.invites.generateMrpack(server.id, { host });
    res.download(pack.absPath, pack.filename, () => {
      fs.unlink(pack.absPath, () => {});
    });
  }

  @Post('status-page')
  async setStatusPage(@Param('id') id: string, @Req() req: Request) {
    const server = await this.mustGet(id);
    const { enabled, slug } = parse(statusPageSchema, req.body);
    const config = await this.statusPage.setStatusPage(server.id, {
      enabled,
      slug: slug || undefined,
    });
    this.events.recordEvent({
      serverId: server.id,
      actor: req.user ? req.user.username : 'admin',
      type: 'integration-changed',
      summary: `Public status page ${config.enabled ? `enabled at /status/${config.slug}` : 'disabled'}`,
    });
    return { ok: true, statusPage: config };
  }
}
