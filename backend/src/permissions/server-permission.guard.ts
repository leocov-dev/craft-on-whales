import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { DbService } from '../db/db.service';
import { servers } from '../db/schema';
import {
  CAPABILITY_INFO,
  PermissionsService,
  roleDefault,
} from './permissions.service';
import {
  SERVER_PERMISSION_KEY,
  type RequireServerPermissionMeta,
} from './require-server-permission.decorator';

/**
 * Enforces `@RequireServerPermission(cap)` on every route that carries it.
 * A server the caller may not `view` answers 404 (indistinguishable from a
 * server that doesn't exist — see PERMISSIONS_NOTES.md); one they can view
 * but lack `cap` on answers 403. Routes with no `@RequireServerPermission`
 * metadata are not this guard's concern (`route-audit.spec.ts` is what
 * catches a server-scoped route that forgot to apply it).
 */
@Injectable()
export class ServerPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionsService,
    private readonly dbService: DbService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<
      RequireServerPermissionMeta | undefined
    >(SERVER_PERMISSION_KEY, [context.getHandler(), context.getClass()]);
    if (!meta) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const rawId = req.params?.id;
    const serverId = meta.resolve
      ? await meta.resolve(req, { db: this.dbService })
      : typeof rawId === 'string'
        ? rawId
        : undefined;

    if (!serverId) {
      // Nothing to resolve a server from (e.g. a backup id that doesn't
      // exist). Keep the same contract as the found-server case: admins
      // always proceed (the handler answers 404/idempotently itself), a
      // role whose default never has this capability is refused outright,
      // anyone else sees "not found" rather than a tell.
      if (req.user?.role === 'admin') return true;
      const roleCaps = req.user ? roleDefault(req.user.role) : [];
      if (!roleCaps.includes(meta.capability)) {
        throw new ForbiddenException(
          `You don't have the ${CAPABILITY_INFO[meta.capability].label.toLowerCase()} permission on this server.`,
        );
      }
      throw new NotFoundException('Server not found');
    }

    // Existence-only check: a truly missing id falls through to the
    // handler's own 404, which looks identical to the hidden-server 404
    // below — nothing here reveals which case it was.
    const [row] = await this.dbService.db
      .select({ id: servers.id })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    if (!row) return true;

    const effective = await this.permissions.effective(req.user, serverId);
    if (!effective.includes('view')) {
      throw new NotFoundException('Server not found');
    }
    if (!effective.includes(meta.capability)) {
      throw new ForbiddenException(
        `You don't have the ${CAPABILITY_INFO[meta.capability].label.toLowerCase()} permission on this server.`,
      );
    }
    return true;
  }
}
