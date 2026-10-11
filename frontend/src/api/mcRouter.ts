// Wraps GET/POST /api/mc-router. Per-server subdomain/auto-scale assignment
// goes through PATCH /api/servers/:id instead (serversApi.patch, from each
// server's Settings tab) — this module only owns the mc-router container's
// own global settings (base domain, listen port, auto-scale defaults).

import { http } from './http';
import type { McRouterConfig, RouterRoute } from '../../../shared/types/mcRouter';

export type { McRouterConfig, RouterRoute };

interface McRouterResponse {
  ok: true;
  config: McRouterConfig;
  routes: RouterRoute[];
  /** Set when a base-domain change re-labelled routed servers: idle ones were recreated, live ones wait for a restart. */
  routedServers?: { recreated: number; pending: number };
}

export const mcRouterApi = {
  get: () => http.get<McRouterResponse>('/api/mc-router'),
  save: (config: McRouterConfig) => http.post<McRouterResponse>('/api/mc-router', config),
};
