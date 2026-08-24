import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ServerQueryService } from '../servers/server-query.service';
import { EventsService } from '../events/events.service';
import { ChatService } from './chat.service';
import type { ChatHistoryEntry } from '../../../shared/types/chat';

const sendSchema = z.object({
  mode: z.enum(['tellraw', 'say']).default('tellraw'),
  target: z.string().trim().max(32).default('@a'),
  text: z.string().min(1).max(512),
  color: z.string().trim().max(20).optional(),
  bold: z.coerce.boolean().optional(),
  italic: z.coerce.boolean().optional(),
  underlined: z.coerce.boolean().optional(),
  strikethrough: z.coerce.boolean().optional(),
  obfuscated: z.coerce.boolean().optional(),
});

/** Admin chat (tellraw/say over RCON) + chat history. Ports the `/servers/:id/chat*` cluster of `api.ts`. */
@Controller('api/servers/:id/chat')
export class AdminChatController {
  constructor(
    private readonly serverQuery: ServerQueryService,
    private readonly events: EventsService,
    private readonly chat: ChatService,
  ) {}

  @Post()
  @HttpCode(201)
  async send(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    await this.serverQuery.mustGet(id);
    const input = sendSchema.parse(body);
    const result = await this.chat.sendChat(id, {
      ...input,
      actor: req.user!.username,
    });
    return { ok: true, ...result };
  }

  @Get('history')
  async history(@Param('id') id: string, @Query('limit') limitRaw?: string) {
    await this.serverQuery.mustGet(id);
    const limit = Math.min(200, Math.max(1, Number(limitRaw) || 50));
    const rows = await this.events.listEvents({
      serverId: id,
      type: 'chat-sent',
      limit,
    });
    const history = rows
      .map(
        (e): ChatHistoryEntry =>
          ({
            ts: e.createdAt,
            actor: e.actor,
            ...e.details,
          }) as ChatHistoryEntry,
      )
      .reverse();
    return { ok: true, history };
  }
}
