import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Rejects cross-origin state changes (defense in depth next to
 * SameSite=Strict cookies). Global guard, ports legacy `originGuard`
 * unchanged — appropriate for a self-hosted LAN panel, no CSRF-token scheme.
 */
@Injectable()
export class OriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;

    let originHost: string;
    try {
      const rawOrigin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : null);
      if (!rawOrigin) return true; // same-origin fetches may omit both; SameSite covers browsers
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
