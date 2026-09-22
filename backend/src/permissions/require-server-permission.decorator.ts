import { SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { DbService } from '../db/db.service';
import type { Capability } from './permissions.service';

export const SERVER_PERMISSION_KEY = 'requireServerPermission';

/**
 * Resolves the server id a route acts on, when it is not the handler's
 * plain `:id` param (e.g. a backup id → the server that owns it). Returning
 * a falsy value means "no server to resolve" — `ServerPermissionGuard`
 * treats that as not-found for any role whose default lacks the capability,
 * admin/operator-default-ALL roles fall through to the handler (which must
 * itself 404 on the missing target), matching the `:id` case. `db` is
 * `ServerPermissionGuard`'s own `DbService` — resolvers run before any
 * controller instance exists, so they can't close over `this`, but every
 * one needed so far is a single-table lookup.
 */
export type ServerIdResolver = (
  req: Request,
  deps: { db: DbService },
) => Promise<string | null | undefined> | string | null | undefined;

export interface RequireServerPermissionMeta {
  capability: Capability;
  resolve?: ServerIdResolver;
}

/**
 * Marks a route as acting on a specific server, gated on one capability.
 * Paired with `ServerPermissionGuard` (`@UseGuards(ServerPermissionGuard)`).
 * By default the server id is read from `req.params.id`; pass `resolve` for
 * routes keyed by something else (see `backupServerId` for the pattern).
 *
 * Every server-scoped route must carry this — `route-audit.spec.ts` walks
 * the live route table and fails the build if one doesn't. See
 * `PERMISSIONS_NOTES.md`.
 */
export const RequireServerPermission = (
  capability: Capability,
  resolve?: ServerIdResolver,
) => SetMetadata(SERVER_PERMISSION_KEY, { capability, resolve });
