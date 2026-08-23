// Wraps GET /api/servers (full view-model list), GET /api/servers/live
// (hydration poll), and the lifecycle action routes in src/web/routes/api.ts.

import { http } from './http';
import type {
  ServerStatus,
  PackViewModel,
  ServerViewModel,
  LiveServerData,
  LifecycleAction,
  ServerDetail,
  ServerPatch,
} from '../../../shared/types/servers';

export type { ServerStatus, PackViewModel, ServerViewModel, LiveServerData, LifecycleAction, ServerDetail, ServerPatch };

interface ServersListResponse {
  ok: true;
  servers: ServerViewModel[];
}

interface ServersLiveResponse {
  ok: true;
  servers: Record<string, LiveServerData>;
}

interface LifecycleResponse {
  ok: true;
  server: unknown;
}

interface ServerDetailResponse {
  ok: true;
  server: ServerDetail;
}

export const serversApi = {
  list: () => http.get<ServersListResponse>('/api/servers'),
  get: (id: string) => http.get<ServerDetailResponse>(`/api/servers/${id}`),
  live: () => http.get<ServersLiveResponse>('/api/servers/live'),
  action: (id: string, action: LifecycleAction) =>
    http.post<LifecycleResponse>(`/api/servers/${id}/${action}`),
  patch: (id: string, changes: ServerPatch) =>
    http.patch<{ ok: true; server: unknown }>(`/api/servers/${id}`, changes),
  remove: (id: string) => http.delete<{ ok: true }>(`/api/servers/${id}`),
};
