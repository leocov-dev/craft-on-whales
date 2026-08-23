import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Role } from '../auth.service';
import { ROLES_KEY } from '../roles.decorator';

/** Route-scoped role check — replaces legacy `requireRole(...)`. Apply with `@UseGuards(RolesGuard)` + `@Roles(...)`. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!roles || roles.length === 0) return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.user || !roles.includes(req.user.role)) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }
}
