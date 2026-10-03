// Wraps GET /api/servers/:id/health and GET /api/monitoring/overview (backend/src/monitoring). TPS/MSPT arrive
// over the stats socket instead — see composables/useStatsSocket.ts.

import { http } from './http';
import type { ResourceOverview, ServerHealth, TpsReading } from '../../../shared/types/monitoring';

export type { ResourceOverview, ServerHealth, TpsReading };

export const monitoringApi = {
  overview: () => http.get<{ ok: true; overview: ResourceOverview }>('/api/monitoring/overview'),
  health: (serverId: string) =>
    http.get<{ ok: true; health: ServerHealth }>(`/api/servers/${serverId}/health`),
};
