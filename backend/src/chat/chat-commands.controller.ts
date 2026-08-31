import {
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { parseBody } from '../utils/parse-body';
import { ServerQueryService } from '../servers/server-query.service';
import { ContainerService } from '../docker/container.service';
import { ChatCommandsService } from './chat-commands.service';
import { ChatCommandsRuntimeService } from './chat-commands-runtime.service';
import { PLAYER_NAME_RE } from '../utils/player-name';
import type { HydratedCommand } from './chat.types';
import type { ChatCommand } from '../../../shared/types/chat-commands';
import { currentUser } from '../auth/current-user';

/**
 * Legacy's raw `dbApi` returned bare SQL rows (snake_case) directly as JSON;
 * `ChatCommandsService`'s `HydratedCommand` is a Drizzle row (camelCase)
 * instead, so this maps field-by-field back to the snake_case shape the
 * frontend expects — spreading `...c` would silently send `serverId` where
 * the frontend reads `server_id`, etc.
 */
function publicCommand(c: HydratedCommand, actionSummary: string): ChatCommand {
  return {
    id: c.id,
    server_id: c.serverId,
    trigger: c.trigger,
    description: c.description,
    action: c.action,
    params: c.params,
    permission: c.permission,
    cooldown_sec: c.cooldownSec,
    enabled: c.enabled,
    uses: c.uses,
    last_used_at: c.lastUsedAt,
    created_at: c.createdAt,
    msg_pending: c.msgPending,
    msg_success: c.msgSuccess,
    msg_failure: c.msgFailure,
    actionSummary,
  };
}

const RUNNING_STATES = new Set(['running', 'unhealthy']); // rcon still answers while unhealthy

const triggerSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9_-]{1,24}$/i, 'Triggers are 1-24 letters, digits, - or _');
const paramsSchema = z.record(z.string(), z.any());
const messageSchema = z.string().max(200);

const createSchema = z.object({
  trigger: triggerSchema,
  description: z.string().trim().max(200).optional(),
  action: z.enum(['rtp', 'structure', 'biome', 'console']),
  params: paramsSchema.default({}),
  permission: z.enum(['everyone', 'whitelist', 'ops']).default('everyone'),
  cooldownSec: z.coerce.number().int().min(0).max(86400).default(30),
  enabled: z.coerce.boolean().optional(),
  msgPending: messageSchema.optional(),
  msgSuccess: messageSchema.optional(),
  msgFailure: messageSchema.optional(),
});

const patchSchema = z
  .object({
    trigger: triggerSchema.optional(),
    description: z.string().trim().max(200).optional(),
    action: z.enum(['rtp', 'structure', 'biome', 'console']).optional(),
    params: paramsSchema.optional(),
    permission: z.enum(['everyone', 'whitelist', 'ops']).optional(),
    cooldownSec: z.coerce.number().int().min(0).max(86400).optional(),
    enabled: z.coerce.boolean().optional(),
    msgPending: messageSchema.optional(),
    msgSuccess: messageSchema.optional(),
    msgFailure: messageSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Nothing to change',
  });

/** Custom chat commands API. Ports `src/web/routes/chatCommands.ts` (mounted at /api/servers/:id/chat-commands). */
@Controller('api/servers/:id/chat-commands')
export class ChatCommandsController {
  constructor(
    private readonly serverQuery: ServerQueryService,
    private readonly chatCommands: ChatCommandsService,
    private readonly chatCommandsRuntime: ChatCommandsRuntimeService,
    private readonly containers: ContainerService,
  ) {}

  private async requireServer(id: string): Promise<void> {
    if (!(await this.serverQuery.getServer(id)))
      throw new NotFoundException('Server not found');
  }

  private async isRunning(serverId: string): Promise<boolean> {
    try {
      const info = await this.containers.inspectStatus(serverId);
      return info.exists && RUNNING_STATES.has(info.status);
    } catch {
      return false;
    }
  }

  @Get()
  async list(@Param('id') id: string) {
    await this.requireServer(id);
    const commands = await this.chatCommands.listCommands(id);
    return {
      ok: true,
      prefix: await this.chatCommands.getPrefix(id),
      commands: commands.map((c) =>
        publicCommand(c, this.chatCommands.actionSummary(c)),
      ),
      stats: {
        total: commands.length,
        enabled: commands.filter((c) => c.enabled).length,
        uses: commands.reduce((n, c) => n + (c.uses || 0), 0),
      },
    };
  }

  @Post()
  async create(@Param('id') id: string, @Req() req: Request) {
    await this.requireServer(id);
    const input = parseBody(createSchema, req.body);
    const command = await this.chatCommands.createCommand(id, input, {
      actor: currentUser(req).username,
    });
    return {
      ok: true,
      command:
        command &&
        publicCommand(command, this.chatCommands.actionSummary(command)),
    };
  }

  @Patch(':cmdId')
  async update(
    @Param('id') id: string,
    @Param('cmdId') cmdId: string,
    @Req() req: Request,
  ) {
    await this.requireServer(id);
    const changes = parseBody(patchSchema, req.body);
    const command = await this.chatCommands.updateCommand(id, cmdId, changes, {
      actor: currentUser(req).username,
    });
    return {
      ok: true,
      command:
        command &&
        publicCommand(command, this.chatCommands.actionSummary(command)),
    };
  }

  @Delete(':cmdId')
  async remove(
    @Param('id') id: string,
    @Param('cmdId') cmdId: string,
    @Req() req: Request,
  ) {
    await this.requireServer(id);
    await this.chatCommands.deleteCommand(id, cmdId, {
      actor: currentUser(req).username,
    });
    return { ok: true };
  }

  @Post(':cmdId/test')
  async test(
    @Param('id') id: string,
    @Param('cmdId') cmdId: string,
    @Req() req: Request,
  ) {
    await this.requireServer(id);
    const { player } = parseBody(
      z.object({
        player: z
          .string()
          .trim()
          .regex(
            PLAYER_NAME_RE,
            'Player names are 1-16 letters, digits or _ (a leading . or * for Bedrock players is fine)',
          ),
      }),
      req.body,
    );
    if (!(await this.isRunning(id))) {
      throw new ConflictException(
        'The server must be running to test a chat command',
      );
    }
    const result = await this.chatCommandsRuntime.testCommand(
      id,
      cmdId,
      player,
      {
        actor: currentUser(req).username,
      },
    );
    return { ok: true, ...result };
  }

  @Put('prefix')
  async setPrefix(@Param('id') id: string, @Req() req: Request) {
    await this.requireServer(id);
    const { prefix } = parseBody(
      z.object({ prefix: z.string().trim().min(1).max(2) }),
      req.body,
    );
    return {
      ok: true,
      ...(await this.chatCommands.setPrefix(id, prefix, {
        actor: currentUser(req).username,
      })),
    };
  }
}
