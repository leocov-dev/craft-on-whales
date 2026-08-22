'use strict';

// mc-router admin API: global settings + the current per-server route list.
// Per-server hostname/auto-scale assignment itself goes through the existing
// PATCH /api/servers/:id (see routes/api.js) — this router only owns the
// mc-router container's own settings.

import type { Request, Response } from 'express';

const { asyncHandler } = require('../middleware/asyncHandler') as typeof import('../middleware/asyncHandler');
const { makeJsonErrorHandler } =
  require('../middleware/jsonErrorHandler') as typeof import('../middleware/jsonErrorHandler');
const express = require('express');
const { z } = require('zod');
const { requireRole } = require('../middleware/auth') as typeof import('../middleware/auth');
const mcRouter = require('../../services/mcRouter') as typeof import('../../services/mcRouter');

const router = express.Router();
router.use(requireRole('admin'));

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ ok: true, config: mcRouter.getConfig(), routes: mcRouter.listRoutes() });
  })
);

const configSchema = z.object({
  enabled: z.coerce.boolean(),
  listenPort: z.coerce.number().int().min(1024).max(65535),
  autoScaleUp: z.coerce.boolean(),
  autoScaleDown: z.coerce.boolean(),
  autoScaleDownAfter: z
    .string()
    .trim()
    .regex(/^\d+[smh]$/, 'Use a duration like "10m", "1h", or "30s"'),
  autoScaleAsleepMotd: z.string().max(200).optional(),
  autoScaleLoadingMotd: z.string().max(200).optional(),
});

router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const input = configSchema.parse(req.body);
    const cfg = mcRouter.setConfig(input);
    if (cfg.enabled) await mcRouter.activate();
    else await mcRouter.deactivate();
    res.json({ ok: true, config: cfg, routes: mcRouter.listRoutes() });
  })
);

router.use(makeJsonErrorHandler('mc-router'));

export { router };
