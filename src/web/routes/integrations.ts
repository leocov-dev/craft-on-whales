'use strict';

// Integrations API. Mounted at /api/servers/:id/integrations (mergeParams
// gives this router access to :id).

import type { Request, Response, NextFunction } from 'express';
import type { Server } from '../../services/types';

const asyncHandler = require('../middleware/asyncHandler') as typeof import('../middleware/asyncHandler');
const { makeJsonErrorHandler } =
  require('../middleware/jsonErrorHandler') as typeof import('../middleware/jsonErrorHandler');
const express = require('express');
const fs = require('node:fs');
const { z } = require('zod');
const discord = require('../../integrations/discord') as typeof import('../../integrations/discord');
const invites = require('../../integrations/invites') as typeof import('../../integrations/invites');
const statusPage = require('../../integrations/statusPage') as typeof import('../../integrations/statusPage');
const serversService = require('../../services/servers') as typeof import('../../services/servers');
const { recordEvent } = require('../../events') as typeof import('../../events');

const router = express.Router({ mergeParams: true });

const serverIdSchema = z.string().regex(/^srv_[\w-]+$/, 'Invalid server id');

function mustGet(req: Request): Server {
  const serverId = serverIdSchema.parse(req.params.id);
  const server = serversService.getServer(serverId);
  if (!server) {
    const err = new Error('Server not found');
    err.status = 404;
    throw err;
  }
  return server;
}

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const server = mustGet(req);
    res.json({
      ok: true,
      discord: discord.getConfig(server.id),
      statusPage: statusPage.getStatusPage(server.id),
      invite: await invites.inviteInfo(server.id),
    });
  })
);

const discordSchema = z.object({
  enabled: z.boolean(),
  webhookUrl: z
    .string()
    .trim()
    .max(400)
    .regex(
      /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//,
      'Webhook URL must start with https://discord.com/api/webhooks/'
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

router.post(
  '/discord',
  asyncHandler((req: Request, res: Response, _next: NextFunction) => {
    const server = mustGet(req);
    const input = discordSchema.parse(req.body);
    const config = discord.setConfig(server.id, input);
    recordEvent({
      serverId: server.id,
      actor: req.user ? req.user.username : 'admin',
      type: 'integration-changed',
      summary: `Discord webhook ${config.enabled ? 'enabled' : 'disabled'}${input.webhookUrl !== undefined ? ' (URL updated)' : ''}`,
    });
    res.json({ ok: true, discord: config });
  })
);

router.post(
  '/discord/test',
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const server = mustGet(req);
    res.json(await discord.testWebhook(server.id));
  })
);

router.get(
  '/invite',
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const server = mustGet(req);
    res.json({ ok: true, invite: await invites.inviteInfo(server.id) });
  })
);

router.get(
  '/invite/modpack.mrpack',
  asyncHandler(async (req: Request, res: Response, _next: NextFunction) => {
    const server = mustGet(req);
    const host = req.query.host ? z.string().trim().max(260).parse(req.query.host) : undefined;
    const pack = await invites.generateMrpack(server.id, { host });
    // Streamed from data/tmp, then deleted — generated fresh per download so
    // it always reflects the current mod list.
    res.download(pack.absPath, pack.filename, () => {
      fs.unlink(pack.absPath, () => {});
    });
  })
);

router.post(
  '/status-page',
  asyncHandler((req: Request, res: Response, _next: NextFunction) => {
    const server = mustGet(req);
    const { enabled, slug } = z
      .object({
        enabled: z.boolean(),
        // Slug required only when enabling — a page that never had one must
        // still be switch-off-able.
        slug: z
          .string()
          .trim()
          .regex(/^[a-z0-9-]{3,40}$/, 'Slug must be 3–40 chars of lowercase letters, digits, or dashes')
          .optional(),
      })
      .refine((v: { enabled: boolean; slug?: string }) => !v.enabled || v.slug, {
        message: 'A slug is required to enable the status page',
      })
      .parse(req.body);
    const config = statusPage.setStatusPage(server.id, { enabled, slug: slug || undefined });
    recordEvent({
      serverId: server.id,
      actor: req.user ? req.user.username : 'admin',
      type: 'integration-changed',
      summary: `Public status page ${config.enabled ? `enabled at /status/${config.slug}` : 'disabled'}`,
    });
    res.json({ ok: true, statusPage: config });
  })
);

// JSON error handler, same shape as routes/api.js
router.use(makeJsonErrorHandler('integrations'));

export = router;
