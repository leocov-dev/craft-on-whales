// Wraps /api/servers/:id/map (src/web/routes/api.ts) and the /map/:id proxy.

import { http } from './http';
import type { MapConfig } from '../../../shared/types/map';

export type { MapConfig };

interface MapConfigResponse extends MapConfig {
  ok: true;
}

export const mapApi = {
  get: (serverId: string) => http.get<MapConfigResponse>(`/api/servers/${serverId}/map`),
  enable: (serverId: string) =>
    http.post<{ ok: true; hostPort: number }>(`/api/servers/${serverId}/map/enable`),
  disable: (serverId: string) => http.post<{ ok: true }>(`/api/servers/${serverId}/map/disable`),
  viewUrl: (serverId: string) => `/map/${serverId}`,
};
