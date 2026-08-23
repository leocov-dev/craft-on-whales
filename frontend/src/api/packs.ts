// Wraps the modpack search/details/upgrade/rollback routes in
// src/web/routes/api.ts. Creating a NEW server from a pack (POST
// /api/servers/from-pack) belongs to the create-server wizard, not this
// module — it needs the full server-creation form (name/resources/ports),
// built when that page lands.

import { http } from './http';
import type { PackSearchResult } from '../../../shared/types/packs';

export type { PackSearchResult };

interface SearchResponse {
  ok: true;
  results: PackSearchResult[];
}

interface TaskStartResponse {
  ok: true;
  taskId: string;
}

export const packsApi = {
  search: (q: string, platform: 'modrinth' | 'curseforge' = 'modrinth') =>
    http.get<SearchResponse>(`/api/packs/search?q=${encodeURIComponent(q)}&platform=${platform}`),
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
