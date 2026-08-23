// Wraps /api/servers/:id/worlds (per-server world management — distinct from
// the global /api/worlds library in src/api/worlds.ts) in
// src/web/routes/worlds.ts's serverWorlds sub-router.

import { http } from './http';
import type { ServerWorldSummary } from '../../../shared/types/server-worlds';

export type { ServerWorldSummary };

interface CopyToResponse {
  ok: true;
  requiresConfirm?: boolean;
  warnings?: string[];
  installedAs?: string;
  mode?: string;
  sizeBytes?: number;
}

export const serverWorldsApi = {
  list: (serverId: string) =>
    http.get<{ ok: true; worlds: ServerWorldSummary[] }>(`/api/servers/${serverId}/worlds/`),
  copyTo: (
    serverId: string,
    targetServerId: string,
    mode: 'replace' | 'alongside' = 'replace',
    confirm = false,
  ) =>
    http.post<CopyToResponse>(`/api/servers/${serverId}/worlds/copy-to`, {
      targetServerId,
      mode,
      confirm,
    }),
  duplicate: (serverId: string, world: string) =>
    http.post<{ ok: true; name: string; sizeBytes: number }>(
      `/api/servers/${serverId}/worlds/duplicate`,
      { world },
    ),
  rename: (serverId: string, world: string, newName: string) =>
    http.post<{ ok: true; name: string; wasActive: boolean }>(
      `/api/servers/${serverId}/worlds/rename`,
      { world, newName },
    ),
  activate: (serverId: string, world: string) =>
    http.post<{ ok: true; active: string; changed: boolean }>(
      `/api/servers/${serverId}/worlds/activate`,
      { world },
    ),
  downloadUrl: (serverId: string, world: string) =>
    `/api/servers/${serverId}/worlds/${encodeURIComponent(world)}/download`,
  remove: (serverId: string, world: string) =>
    http.delete<{ ok: true; freedBytes: number }>(
      `/api/servers/${serverId}/worlds/${encodeURIComponent(world)}`,
    ),
};
