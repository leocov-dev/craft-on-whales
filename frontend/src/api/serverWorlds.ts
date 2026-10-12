// Wraps /api/servers/:id/worlds (per-server world management — distinct from
// the global /api/worlds library in src/api/worlds.ts) in
// src/web/routes/worlds.ts's serverWorlds sub-router.

import { http } from './http';
import type {
  DeleteChunksResult,
  ServerWorldSummary,
  ShrinkWorldResult,
  WorldChunkMap,
} from '../../../shared/types/server-worlds';

export type { DeleteChunksResult, ServerWorldSummary, ShrinkWorldResult, WorldChunkMap };

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
  shrink: (
    serverId: string,
    opts: {
      world: string;
      dryRun: boolean;
      minInhabitedTicks?: number;
      spawnKeepChunks?: number;
    },
  ) =>
    http.post<{ ok: true; result: ShrinkWorldResult }>(
      `/api/servers/${serverId}/worlds/shrink`,
      opts,
    ),
  chunks: (serverId: string, world: string) =>
    http.get<{ ok: true } & WorldChunkMap>(
      `/api/servers/${serverId}/worlds/${encodeURIComponent(world)}/chunks`,
    ),
  regionInhabited: (serverId: string, world: string, dimension: string, rx: number, rz: number) =>
    http.get<{ ok: true; ticks: Array<number | null> }>(
      `/api/servers/${serverId}/worlds/${encodeURIComponent(world)}/chunks/inhabited?` +
        new URLSearchParams({ dimension, rx: String(rx), rz: String(rz) }).toString(),
    ),
  deleteChunks: (
    serverId: string,
    opts: {
      world: string;
      dimension: string;
      chunks: Array<{ cx: number; cz: number }>;
      backup: boolean;
    },
  ) =>
    http.post<{ ok: true; result: DeleteChunksResult }>(
      `/api/servers/${serverId}/worlds/chunks/delete`,
      opts,
    ),
  downloadUrl: (serverId: string, world: string) =>
    `/api/servers/${serverId}/worlds/${encodeURIComponent(world)}/download`,
  remove: (serverId: string, world: string) =>
    http.delete<{ ok: true; freedBytes: number }>(
      `/api/servers/${serverId}/worlds/${encodeURIComponent(world)}`,
    ),
};
