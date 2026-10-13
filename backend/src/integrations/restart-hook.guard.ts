import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { RestartHookService } from './restart-hook.service';

/**
 * Authenticates `POST /api/hooks/servers/:id/restart` with the Bearer key
 * minted for that exact server. Every failure — malformed header, unknown
 * server, hook disabled, wrong key — answers the same 401 so a caller can't
 * probe which servers exist or have a hook.
 */
@Injectable()
export class RestartHookGuard implements CanActivate {
  constructor(private readonly hooks: RestartHookService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    const id = req.params.id;
    if (
      !match ||
      typeof id !== 'string' ||
      !(await this.hooks.verify(id, match[1] as string))
    ) {
      throw new UnauthorizedException('Invalid or missing restart key.');
    }
    return true;
  }
}
