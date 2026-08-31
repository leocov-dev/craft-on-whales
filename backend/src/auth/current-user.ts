import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { PublicUser } from '../../../shared/types/settings';

/**
 * Safe replacement for the repo-wide `req.user!` pattern —
 * `SessionAuthGuard` is a global `APP_GUARD` and always populates `req.user`
 * before any non-`@Public()` handler runs, so this is safe by construction,
 * but throws a clean 401 instead of letting a raw `TypeError` through if
 * that invariant is ever violated by a routing mistake (e.g. a route
 * mistakenly marked `@Public()` while still reading the caller's identity).
 */
export function currentUser(req: Request): PublicUser {
  if (!req.user) throw new UnauthorizedException('Not signed in');
  return req.user;
}
