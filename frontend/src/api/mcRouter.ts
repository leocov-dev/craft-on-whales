// Wraps GET/POST /api/mc-router (src/web/routes/mcRouter.ts). Per-server
// hostname/auto-scale assignment goes through PATCH /api/servers/:id instead
// (see src/api/servers.ts's future patch() addition) — this module only owns
// the mc-router container's own settings.

import { http } from './http';
import type { McRouterConfig, RouterRoute } from '../../../shared/types/mcRouter';

export type { McRouterConfig, RouterRoute };

interface McRouterResponse {
  ok: true;
  config: McRouterConfig;
  routes: RouterRoute[];
}

export const mcRouterApi = {
  get: () => http.get<McRouterResponse>('/api/mc-router'),
  save: (config: McRouterConfig) => http.post<McRouterResponse>('/api/mc-router', config),
  saveRoute: (serverId: string, routerHostname: string, routerAutoScale: 'on' | 'off' | null) =>
    http.patch<{ ok: true }>(`/api/servers/${serverId}`, { routerHostname, routerAutoScale }),
};
