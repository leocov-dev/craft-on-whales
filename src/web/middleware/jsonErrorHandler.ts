'use strict';

import type { NextFunction, Request, Response } from 'express';
import type { ZodError } from 'zod';

const { z } = require('zod');
const multer = require('multer');

interface JsonErrorHandlerOptions {
  /** Message returned for a multer LIMIT_FILE_SIZE error. */
  fileTooLarge?: string;
}

/**
 * Map known infrastructure errors to a user-safe message, or null if the error
 * isn't recognized (callers redact unrecognized 5xx rather than leaking internals).
 */
function friendlyError(err: Error): string | null {
  const msg = err.message || 'Unexpected error';
  // Docker daemon connection failures are socket/pipe *connect* errors, or name
  // the docker socket directly. Do NOT match a bare "docker" substring — it also
  // appears in data-dir paths like /home/docker/…, which would mislabel an
  // ordinary filesystem EACCES (e.g. deleting container-owned files) as this.
  if (/connect (ECONNREFUSED|ENOENT|EACCES|ETIMEDOUT)\b/i.test(msg) || /docker\.sock|docker_engine/i.test(msg)) {
    return 'Docker is not reachable. Is Docker running?';
  }
  if (/port is already allocated/i.test(msg)) return 'That port is already taken by another container.';
  if (/No such image/i.test(msg))
    return 'The server image is missing — it will be pulled automatically on the next start.';
  return null;
}

/**
 * Build a JSON error handler for an API router. Handles zod validation errors,
 * multer upload-limit errors (message via opts.fileTooLarge), maps known
 * infrastructure errors to friendly text, and — crucially — never leaks raw
 * internal error text (SQLite messages, absolute paths) on an unexpected 5xx.
 */
function makeJsonErrorHandler(tag: string, { fileTooLarge = 'File too large' }: JsonErrorHandlerOptions = {}) {
  // Express recognizes an error handler by its 4-arg signature (next unused).
  return function jsonErrorHandler(err: Error, req: Request, res: Response, next: NextFunction): void {
    if (err instanceof z.ZodError) {
      const zodErr = err as unknown as ZodError;
      res.status(400).json({ ok: false, error: zodErr.issues.map((i) => i.message).join('; ') });
      return;
    }
    if (err instanceof multer.MulterError) {
      res.status(400).json({ ok: false, error: err.code === 'LIMIT_FILE_SIZE' ? fileTooLarge : err.message });
      return;
    }
    const status = err.status || (err as Error & { statusCode?: number }).statusCode || 500;
    if (status >= 500) console.error(`[${tag}]`, err);
    const friendly = friendlyError(err);
    if (friendly) {
      res.status(status).json({ ok: false, error: friendly });
      return;
    }
    if (status >= 500) {
      res.status(status).json({ ok: false, error: 'Unexpected server error — check the panel logs.' });
      return;
    }
    res.status(status).json({ ok: false, error: err.message || 'Unexpected error' });
  };
}

export { makeJsonErrorHandler, friendlyError };
