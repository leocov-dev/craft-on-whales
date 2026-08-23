import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService } from '../auth.service';
import { IS_PUBLIC_KEY } from '../public.decorator';

/**
 * Session gate — global guard, ports legacy `requireAuth`. Routes marked
 * `@Public()` (login, setup, status, …) skip straight through. Everything
 * else needs `req.session.userId` (populated by express-session's own Store
 * lookup in main.ts) resolving to a real user, which is then attached to
 * `req.user` for RolesGuard/WriteGuard and route handlers to read.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    const req = context.switchToHttp().getRequest<Request>();

    if ((await this.authService.firstRunNeeded()) && !isPublic) {
      throw new UnauthorizedException('Panel setup incomplete');
    }
    if (isPublic) return true;

    const userId = req.session?.userId;
    if (userId) {
      const user = await this.authService.getUser(userId);
      if (user) {
        req.user = user;
        return true;
      }
    }
    throw new UnauthorizedException('Not signed in');
  }
}
