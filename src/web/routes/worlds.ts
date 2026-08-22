'use strict';

// World management API.
//   module.exports          → mount at /api/worlds        (global world library)
//   module.exports.serverWorlds → mount at /api/servers/:id/worlds (mergeParams)

import type { Request, Response, NextFunction, Router } from 'express';
import type { Row } from '../../db/types';

const asyncHandler = require('../middleware/asyncHandler') as typeof import('../middleware/asyncHandler');
const { makeJsonErrorHandler } =
  require('../middleware/jsonErrorHandler') as typeof import('../middleware/jsonErrorHandler');
const fsp = require('node:fs/promises');
const express = require('express');
const multer = require('multer') as typeof import('multer');
const { z } = require('zod');
const worlds = require('../../services/worlds') as typeof import('../../services/worlds');
const { dataPath } = require('../../storage/pathGuard') as typeof import('../../storage/pathGuard');
const db = require('../../db') as typeof import('../../db');

// requireAuth guarantees req.user on every /api request.
const actorOf = (req: Request) => req.user!.username;

const upload = multer({
  dest: dataPath('tmp'),
  limits: { fileSize: 20 * 1024 ** 3 }, // worlds get big
});

const files = require('../../services/files') as typeof import('../../services/files');
const MAX_WORLD_UPLOAD_BYTES = 20 * 1024 ** 3;

// Reject on the declared Content-Length before multer streams the whole world
// archive into data/tmp (which would otherwise fill the disk regardless of quota).
async function worldUploadPreflight(req: Request, res: Response, next: NextFunction) {
  try {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_WORLD_UPLOAD_BYTES) {
      return res.status(413).json({
        ok: false,
        error: `World archive too large (limit ${Math.round(MAX_WORLD_UPLOAD_BYTES / 1024 ** 3)} GB).`,
      });
    }
    // A world archive is extracted after upload, so it needs headroom for both the
    // upload and the (larger) extracted copy — check disk against ~3× the upload.
    if (declared > 0) await files.assertDiskFree(declared * 3);
    next();
  } catch (err) {
    next(err);
  }
}

const worldNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\\/\0]+$/, 'World names cannot contain path separators')
  .refine((v: string) => !v.startsWith('.'), { message: 'World names cannot start with a dot' });
const modeSchema = z.enum(['replace', 'alongside']);

// ---------------------------------------------------------------------------
// Global library router (/api/worlds)

// `router.serverWorlds` is a second, unrelated router bolted onto this one so
// a single require('./worlds') gives web/routes/api.js both mount points (see
// the export at the bottom); the type carries that extra property locally
// rather than augmenting express's global Router type.
const router: Router & { serverWorlds?: Router } = express.Router();

router.get(
  '/',
  asyncHandler((req: Request, res: Response, next: NextFunction) => {
    res.json({ ok: true, worlds: worlds.libraryWorlds() });
  })
);

router.post(
  '/upload',
  worldUploadPreflight,
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) throw badRequest('Attach a world archive (zip, .mcworld, tar or tar.gz)');
      const { name } = z.object({ name: z.string().trim().max(120).optional() }).parse(req.body || {});
      const row = await worlds.importArchive(req.file.path, {
        name,
        originalName: req.file.originalname,
        actor: actorOf(req),
      });
      res.status(201).json({ ok: true, world: libVM(row) });
    } catch (err) {
      if (req.file) await fsp.rm(req.file.path, { force: true }).catch(() => {});
      next(err);
    }
  }
);

router.post(
  '/extract',
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { serverId, name } = z
      .object({
        serverId: z.string().trim().min(1).max(40),
        name: z.string().trim().max(120).optional(),
      })
      .parse(req.body);
    const row = await worlds.extractFromServer(serverId, { name, actor: actorOf(req) });
    res.status(201).json({ ok: true, world: libVM(row) });
  })
);

router.post(
  '/:id/install',
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { serverId, mode, newName, confirm } = z
      .object({
        serverId: z.string().trim().min(1).max(40),
        mode: modeSchema.default('replace'),
        newName: worldNameSchema.optional(),
        confirm: z.coerce.boolean().optional(),
      })
      .parse(req.body);

    // Compat check first: warnings block the install until confirmed.
    const worldId = String(req.params.id);
    const warnings = worlds.installWarnings(worldId, serverId);
    if (warnings.length && !confirm) {
      return res.json({ ok: true, requiresConfirm: true, warnings });
    }
    const result = await worlds.installToServer(worldId, serverId, { mode, newName, actor: actorOf(req) });
    res.json({ ok: true, ...result });
  })
);

router.get(
  '/:id/download',
  asyncHandler((req: Request, res: Response, next: NextFunction) => {
    const lib = db.get("SELECT * FROM library_files WHERE id = ? AND category = 'world'", String(req.params.id));
    if (!lib) throw notFound('World not found in the library');
    const filename = String(lib.filename);
    res.download(dataPath(String(lib.rel_path)), filename.endsWith('.zip') ? filename : `${filename}.zip`);
  })
);

// Rename a library world (display name only — the archive is untouched).
router.patch(
  '/:id',
  asyncHandler((req: Request, res: Response, next: NextFunction) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(120) }).parse(req.body);
    const lib = db.get("SELECT * FROM library_files WHERE id = ? AND category = 'world'", String(req.params.id));
    if (!lib) throw notFound('World not found in the library');
    db.run('UPDATE library_files SET name = ? WHERE id = ?', name, lib.id as string);
    (require('../../events') as typeof import('../../events')).recordEvent({
      actor: actorOf(req),
      type: 'world-renamed',
      summary: `Library world renamed: "${lib.name}" → "${name}"`,
      details: { libraryId: lib.id },
    });
    res.json({ ok: true, world: { id: lib.id, name } });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    res.json({ ok: true, ...(await worlds.deleteLibraryWorld(String(req.params.id), { actor: actorOf(req) })) });
  })
);

// ---------------------------------------------------------------------------
// Per-server router (/api/servers/:id/worlds)

const serverWorlds = express.Router({ mergeParams: true });

serverWorlds.get(
  '/',
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    res.json({ ok: true, worlds: await worlds.listServerWorlds(String(req.params.id)) });
  })
);

serverWorlds.post(
  '/copy-to',
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const id = String(req.params.id);
    const { targetServerId, mode, newName, confirm } = z
      .object({
        targetServerId: z.string().trim().min(1).max(40),
        mode: modeSchema.default('replace'),
        newName: worldNameSchema.optional(),
        confirm: z.coerce.boolean().optional(),
      })
      .parse(req.body);

    const warnings = worlds.copyWarnings(id, targetServerId);
    if (warnings.length && !confirm) {
      return res.json({ ok: true, requiresConfirm: true, warnings });
    }
    const result = await worlds.copyBetweenServers(id, targetServerId, {
      mode,
      newName,
      actor: actorOf(req),
    });
    res.json({
      ok: true,
      installedAs: result.installedAs,
      mode: result.mode,
      sizeBytes: result.sizeBytes,
      warnings: result.warnings,
    });
  })
);

serverWorlds.post(
  '/duplicate',
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { world } = z.object({ world: worldNameSchema }).parse(req.body);
    res.json({ ok: true, ...(await worlds.duplicateWorld(String(req.params.id), world, { actor: actorOf(req) })) });
  })
);

serverWorlds.post(
  '/rename',
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { world, newName } = z.object({ world: worldNameSchema, newName: worldNameSchema }).parse(req.body);
    res.json({
      ok: true,
      ...(await worlds.renameWorld(String(req.params.id), world, newName, { actor: actorOf(req) })),
    });
  })
);

serverWorlds.post(
  '/reset',
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const opts = z
      .object({
        seedMode: z.enum(['keep', 'random', 'custom']).default('random'),
        seed: z.string().trim().max(200).optional(),
        levelType: z.enum(['DEFAULT', 'FLAT', 'LARGEBIOMES', 'AMPLIFIED']).optional(),
        backup: z.coerce.boolean().default(true),
      })
      .parse(req.body);
    res.json({
      ok: true,
      ...(await worlds.resetWorld(String(req.params.id), { ...opts, actor: actorOf(req) })),
    });
  })
);

serverWorlds.post(
  '/activate',
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const { world } = z.object({ world: worldNameSchema }).parse(req.body);
    res.json({ ok: true, ...(await worlds.activateWorld(String(req.params.id), world, { actor: actorOf(req) })) });
  })
);

serverWorlds.get(
  '/:world/download',
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const world = worldNameSchema.parse(req.params.world);
    const staged = await worlds.prepareWorldDownload(String(req.params.id), world, { actor: actorOf(req) });
    res.download(staged.absPath, staged.filename, () => {
      fsp.rm(staged.absPath, { force: true }).catch(() => {});
    });
  })
);

serverWorlds.delete(
  '/:world',
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const world = worldNameSchema.parse(req.params.world);
    res.json({
      ok: true,
      ...(await worlds.deleteServerWorld(String(req.params.id), world, { actor: actorOf(req) })),
    });
  })
);

// ---------------------------------------------------------------------------

function libVM(row: Row) {
  return {
    id: row.id,
    name: row.name,
    filename: row.filename,
    size: row.size_bytes,
    flavor: row.world_flavor,
    mcVersion: row.version,
    source: row.world_source,
    created: row.created_at,
  };
}

function badRequest(message: string): Error {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function notFound(message: string): Error {
  const err = new Error(message);
  err.status = 404;
  return err;
}

// JSON error handlers (same contract as /api): friendly zod messages + status.
for (const r of [router, serverWorlds]) {
  r.use(makeJsonErrorHandler('worlds', { fileTooLarge: 'That archive is too large (20 GB limit)' }));
}

// module.exports.serverWorlds → mount at /api/servers/:id/worlds (see app.js).
router.serverWorlds = serverWorlds;
export = router;
