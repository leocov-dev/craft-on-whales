'use strict';

// Custom chat commands API. Mounted at /api/servers/:id/chat-commands
// (mergeParams carries :id down from the mount point).

import type { Request, Response, NextFunction } from 'express';

const { asyncHandler } = require('../middleware/asyncHandler') as typeof import('../middleware/asyncHandler');
const { makeJsonErrorHandler } =
  require('../middleware/jsonErrorHandler') as typeof import('../middleware/jsonErrorHandler');
const express = require('express');
const { z } = require('zod');
const servers = require('../../services/servers') as typeof import('../../services/servers');
const chatCommands = require('../../services/chatCommands') as typeof import('../../services/chatCommands');
const { inspectStatus } = require('../../docker/containers') as typeof import('../../docker/containers');
const { PLAYER_NAME_RE } = require('../../utils/playerName') as typeof import('../../utils/playerName');

const router = express.Router({ mergeParams: true });

const RUNNING_STATES = new Set(['running', 'unhealthy']); // rcon still answers while unhealthy

const triggerSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9_-]{1,24}$/i, 'Triggers are 1-24 letters, digits, - or _');
const paramsSchema = z.record(z.string(), z.any());

const messageSchema = z.string().max(200); // '' clears it (back to the built-in default)

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
  .refine((v: Record<string, unknown>) => Object.values(v).some((x) => x !== undefined), {
    message: 'Nothing to change',
  });

function requireServer(id: string) {
  const server = servers.getServer(id);
  if (!server) {
    const err = new Error('Server not found');
    err.status = 404;
    throw err;
  }
  return server;
}

async function isRunning(serverId: string): Promise<boolean> {
  try {
    const info = await inspectStatus(serverId);
    return info.exists && RUNNING_STATES.has(info.status);
  } catch {
    return false;
  }
}

router.get(
  '/',
  asyncHandler((req: Request, res: Response, next: NextFunction) => {
    const id = String(req.params.id);
    requireServer(id);
    const commands = chatCommands.listCommands(id);
    res.json({
      ok: true,
      prefix: chatCommands.getPrefix(id),
      commands: commands.map((c) => ({ ...c, actionSummary: chatCommands.actionSummary(c) })),
      stats: {
        total: commands.length,
        enabled: commands.filter((c) => c.enabled).length,
        uses: commands.reduce((n, c) => n + (c.uses || 0), 0),
      },
    });
  })
);

router.post(
  '/',
  asyncHandler((req: Request, res: Response, next: NextFunction) => {
    const id = String(req.params.id);
    requireServer(id);
    const input = createSchema.parse(req.body);
    // zod's inferred output type marks defaulted fields as optional even though
    // .parse() always fills them — createCommand's stricter ValidateSpecInput
    // (shared with direct service callers) wants them required.
    const command = chatCommands.createCommand(id, input as Parameters<typeof chatCommands.createCommand>[1], {
      actor: req.user!.username,
    });
    res.status(201).json({ ok: true, command });
  })
);

router.patch(
  '/:cmdId',
  asyncHandler((req: Request, res: Response, next: NextFunction) => {
    const id = String(req.params.id);
    requireServer(id);
    const changes = patchSchema.parse(req.body);
    const command = chatCommands.updateCommand(id, String(req.params.cmdId), changes, {
      actor: req.user!.username,
    });
    res.json({ ok: true, command });
  })
);

router.delete(
  '/:cmdId',
  asyncHandler((req: Request, res: Response, next: NextFunction) => {
    const id = String(req.params.id);
    requireServer(id);
    chatCommands.deleteCommand(id, String(req.params.cmdId), { actor: req.user!.username });
    res.json({ ok: true });
  })
);

// Execute NOW as a named player — same path as chat, minus cooldown/permission.
router.post(
  '/:cmdId/test',
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const id = String(req.params.id);
    requireServer(id);
    const { player } = z
      .object({
        player: z
          .string()
          .trim()
          .regex(
            PLAYER_NAME_RE,
            'Player names are 1-16 letters, digits or _ (a leading . or * for Bedrock players is fine)'
          ),
      })
      .parse(req.body);
    if (!(await isRunning(id))) {
      throw Object.assign(new Error('The server must be running to test a chat command'), { status: 409 });
    }
    const result = await chatCommands.testCommand(id, String(req.params.cmdId), player, {
      actor: req.user!.username,
    });
    res.json({ ok: true, ...result });
  })
);

router.put(
  '/prefix',
  asyncHandler((req: Request, res: Response, next: NextFunction) => {
    const id = String(req.params.id);
    requireServer(id);
    const { prefix } = z.object({ prefix: z.string().trim().min(1).max(2) }).parse(req.body);
    res.json({ ok: true, ...chatCommands.setPrefix(id, prefix, { actor: req.user!.username }) });
  })
);

// JSON error handler for this subtree (mirrors routes/api.js)
router.use(makeJsonErrorHandler('chat-commands-api'));

export { router };
