import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiTokensService } from './api-tokens.service';
import { ApiRateLimitService } from './api-rate-limit.service';

/**
 * Route-scoped guard for `/api/v1/*` (the public read-only API). Applied
 * via `@UseGuards(BearerAuthGuard)` on `PublicApiController` — not global,
 * matching `ServerPermissionGuard`'s precedent of "guards that only concern
 * a specific slice of routes are scoped there, not registered as
 * `APP_GUARD`." Those routes are also `@Public()` + `@SkipOriginCheck()`
 * (see API_TOKENS_NOTES.md) so the cookie-session guards don't run at all.
 *
 * Rate limiting runs here too, per-token *and* per-IP, before the token is
 * even resolved — mirrors `LoginRateLimitService`'s per-IP layer so an
 * unauthenticated burst can't dodge the limit by omitting a token.
 */
@Injectable()
export class BearerAuthGuard implements CanActivate {
  constructor(
    private readonly apiTokens: ApiTokensService,
    private readonly rateLimit: ApiRateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();

    this.rateLimit.check(`ip:${req.ip || 'unknown'}`);

    const header = req.headers.authorization || '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) {
      throw new UnauthorizedException(
        'Missing or malformed Authorization header.',
      );
    }
    const raw = match[1] as string;

    const resolved = await this.apiTokens.resolve(raw);
    if (!resolved) {
      throw new UnauthorizedException('Invalid, revoked, or expired token.');
    }

    this.rateLimit.check(`token:${resolved.id}`);

    req.apiToken = resolved;
    return true;
  }
}
