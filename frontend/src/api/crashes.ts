// Wraps /api/servers/:id/crashes (src/web/routes/crashes.ts).

import { http } from './http';
import type { CrashReport } from '../../../shared/types/crashes';

export type { CrashReport };

interface CrashesResponse {
  ok: true;
  crashes: CrashReport[];
}

export const crashesApi = {
  list: (serverId: string) => http.get<CrashesResponse>(`/api/servers/${serverId}/crashes`),
  markViewed: (serverId: string, crashId: string) =>
    http.post<{ ok: true }>(`/api/servers/${serverId}/crashes/${crashId}/viewed`),
  remove: (serverId: string, crashId: string) =>
    http.delete<{ ok: true }>(`/api/servers/${serverId}/crashes/${crashId}`),
  textUrl: (serverId: string, crashId: string) =>
    `/api/servers/${serverId}/crashes/${crashId}/text`,
};
