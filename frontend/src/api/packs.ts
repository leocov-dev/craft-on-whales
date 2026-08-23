// Wraps the modpack search/details/resolve/upgrade/rollback routes and
// server-from-pack creation in src/web/routes/api.ts.

import { http } from './http';
import type { PackSearchResult, PackPlatform, PackDetails, PackModInfo } from '../../../shared/types/packs';

export type { PackSearchResult, PackPlatform, PackDetails, PackModInfo };

interface SearchResponse {
  ok: true;
  results: PackSearchResult[];
}

interface TaskStartResponse {
  ok: true;
  taskId: string;
}

interface ResolveResponse {
  ok: true;
  pack: {
    platform: PackPlatform;
    projectRef: string;
    projectId: string;
    projectName: string;
    iconUrl?: string | null;
    versionId: string;
    versionName: string;
    mcVersion: string | null;
    loaders?: string[];
  };
}

interface DetailsResponse {
  ok: true;
  pack: PackDetails;
}

interface PackModsResponse {
  ok: true;
  pack: { name: string; version: string };
  mods: PackModInfo[];
}

/** Payload for `POST /api/servers/from-pack` — creates a new server pinned to a resolved pack. */
export interface FromPackInput {
  name: string;
  description?: string | undefined;
  icon?: string | undefined;
  accent?: string | undefined;
  platform: PackPlatform;
  ref: string;
  versionId?: string | undefined;
  heapMb?: number | undefined;
  containerMemoryMb?: number | undefined;
  diskQuotaGb?: number | undefined;
  portGame?: number | undefined;
  env?: Record<string, string> | undefined;
}

export const packsApi = {
  search: (q: string, platform: 'modrinth' | 'curseforge' = 'modrinth') =>
    http.get<SearchResponse>(`/api/packs/search?q=${encodeURIComponent(q)}&platform=${platform}`),
  resolve: (platform: PackPlatform, ref: string, versionId?: string) =>
    http.post<ResolveResponse>('/api/packs/resolve', { platform, ref, ...(versionId ? { versionId } : {}) }),
  details: (query: { platform: PackPlatform; ref: string } | { serverId: string }) => {
    const params = new URLSearchParams(query);
    return http.get<DetailsResponse>(`/api/packs/details?${params.toString()}`);
  },
  packMods: (serverId: string) => http.get<PackModsResponse>(`/api/servers/${serverId}/pack/mods`),
  applyToServer: (serverId: string, platform: PackPlatform, ref: string, opts: { versionId?: string; force?: boolean } = {}) =>
    http.post<ResolveResponse>(`/api/servers/${serverId}/pack`, { platform, ref, ...opts }),
  fromPack: (input: FromPackInput) => http.post<TaskStartResponse>('/api/servers/from-pack', input),
  upgrade: (serverId: string, versionId?: string) =>
    http.post<TaskStartResponse>(
      `/api/servers/${serverId}/pack/upgrade`,
      versionId ? { versionId } : {},
    ),
  rollback: (serverId: string, backupId?: string) =>
    http.post<TaskStartResponse>(
      `/api/servers/${serverId}/pack/rollback`,
      backupId ? { backupId } : {},
    ),
};
