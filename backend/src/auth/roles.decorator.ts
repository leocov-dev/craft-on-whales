import { SetMetadata } from '@nestjs/common';
import type { Role } from './auth.service';

export const ROLES_KEY = 'roles';

/** Restricts a route to the listed roles — replaces legacy `requireRole(...)`. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
