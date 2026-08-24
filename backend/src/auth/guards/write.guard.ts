import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ALLOW_VIEWER_WRITE_KEY } from '../allow-viewer-write.decorator';

/**
 * Blocks state-changing requests (anything but GET/HEAD/OPTIONS) from
 * read-only viewer accounts. Global guard, runs after SessionAuthGuard, so
 * the documented "viewer = read-only" contract is enforced by the backend,
 * not just the UI. Ports legacy `requireWrite`. Routes marked
 * `@AllowViewerWrite()` (self-service account actions — legacy exempted
 * these by mounting `/api/account` before the `requireWrite` middleware)
 * skip this check.
 */
@Injectable()
export class WriteGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (
      req.method === 'GET' ||
      req.method === 'HEAD' ||
      req.method === 'OPTIONS'
    )
      return true;
    const allowViewer = this.reflector.getAllAndOverride<boolean>(
      ALLOW_VIEWER_WRITE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowViewer) return true;
    if (req.user && req.user.role === 'viewer') {
      throw new ForbiddenException('Your role (viewer) is read-only.');
    }
    return true;
  }
}
