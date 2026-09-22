// Wraps the admin-only /api/permissions routes (backend/src/permissions/permissions.controller.ts).

import { http } from './http';
import type { Role } from './auth';

export type Capability =
  | 'view'
  | 'power'
  | 'console'
  | 'players'
  | 'content'
  | 'backups'
  | 'files'
  | 'settings'
  | 'delete';

export interface CapabilityInfo {
  key: Capability;
  label: string;
  help: string;
}

export interface PermissionsMatrixUser {
  id: string;
  username: string;
  role: Role;
}

export interface PermissionsMatrixServer {
  id: string;
  name: string;
}

export interface PermissionsMatrixRow {
  user: PermissionsMatrixUser;
  roleDefault: Capability[];
  servers: {
    serverId: string;
    grant: Capability[] | null;
    effective: Capability[];
  }[];
}

export interface PermissionsMatrix {
  ok: true;
  capabilities: CapabilityInfo[];
  users: PermissionsMatrixUser[];
  servers: PermissionsMatrixServer[];
  rows: PermissionsMatrixRow[];
}

export const permissionsApi = {
  matrix: () => http.get<PermissionsMatrix>('/api/permissions'),
  setGrant: (userId: string, serverId: string, perms: Capability[] | null) =>
    http.post<{ ok: true; grant: Capability[] | null; effective: Capability[] }>(
      `/api/permissions/${userId}/${serverId}`,
      { perms },
    ),
};
