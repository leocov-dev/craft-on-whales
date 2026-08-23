// Wraps GET /api/updates and the update-check/apply routes in
// src/web/routes/api.ts.

import { http } from './http';
import type { OutdatedRow } from '../../../shared/types/updates';

export type { OutdatedRow };

interface UpdatesResponse {
  ok: true;
  updates: OutdatedRow[];
  lastChecked: string | null;
}

interface CheckStartResponse {
  ok: true;
  taskId: string;
}

export const updatesApi = {
  list: () => http.get<UpdatesResponse>('/api/updates'),
  checkAll: () => http.post<CheckStartResponse>('/api/updates/check'),
  upgradePack: (serverId: string, versionId?: string) =>
    http.post<CheckStartResponse>(
      `/api/servers/${serverId}/pack/upgrade`,
      versionId ? { versionId } : {},
    ),
  updateMod: (serverId: string, contentId: string) =>
    http.post<{ ok: true; installed: unknown }>(`/api/servers/${serverId}/mods/update`, {
      contentId,
    }),
};
