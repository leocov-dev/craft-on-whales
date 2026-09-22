import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ConfigService } from '../../config/config.service';
import { SKIP_ORIGIN_CHECK_KEY } from '../skip-origin-check.decorator';

/**
 * Rejects cross-origin state changes (defense in depth next to the
 * SameSite session cookie — see `ConfigService.cookieSameSite` /
 * `AUTH_NOTES.md`). Global guard, ports legacy `originGuard`, extended with
 * `COOKIE_SAMESITE=none` handling: under `none` the cookie alone gives the
 * browser no CSRF protection (it's sent cross-site by design), so a
 * state-changing request carrying neither header is rejected outright
 * rather than waved through as "presumably same-site."
 *
 * Routes marked `@SkipOriginCheck()` (the public Bearer-token API — see
 * `API_TOKENS_NOTES.md`) skip this check entirely: a Bearer token isn't
 * auto-attached by the browser, so there's nothing for a same-origin check
 * to defend there.
 */
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const skip = this.reflector.getAllAndOverride<boolean>(
      SKIP_ORIGIN_CHECK_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (skip) return true;

    const req = context.switchToHttp().getRequest<Request>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;

    const rawOrigin =
      req.headers.origin ||
      req.headers.referer ||
      // Fall through so parsing below always sees the same shape.
      null;

    if (!rawOrigin) {
      if (this.config.cookieSameSite === 'none') {
        // Under SameSite=None the cookie is sent on cross-site requests too,
        // so an absent Origin *and* Referer leaves nothing to check against
        // — treat that as untrustworthy rather than assume same-site.
        throw new ForbiddenException('Cross-origin request rejected');
      }
      // Under lax/strict, a legitimate same-site browser request can still
      // omit both headers on some navigations/older browsers; SameSite
      // itself is the primary defense in that case.
      return true;
    }

    let originHost: string;
    try {
      originHost = new URL(rawOrigin).host;
    } catch {
      // A malformed Origin/Referer on a state-changing request is not trustworthy.
      throw new ForbiddenException('Cross-origin request rejected');
    }
    if (originHost !== req.headers.host) {
      throw new ForbiddenException('Cross-origin request rejected');
    }
    return true;
  }
}
