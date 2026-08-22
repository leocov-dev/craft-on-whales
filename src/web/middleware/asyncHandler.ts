'use strict';

import type { NextFunction, Request, Response } from 'express';

/**
 * Wrap an async (or sync) route handler so a thrown error or rejected promise
 * is forwarded to Express's error handling — no hand-written try/catch needed.
 *
 *   router.get('/', asyncHandler(async (req, res) => { ... }));
 */
function asyncHandler<Req extends Request = Request, Res extends Response = Response>(
  fn: (req: Req, res: Res, next: NextFunction) => unknown
) {
  return function wrapped(req: Req, res: Res, next: NextFunction): void {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export = asyncHandler;
