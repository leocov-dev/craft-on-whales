// Wraps /api/servers/:id/world/* (world-controls.controller.ts): the
// time/weather/gamerule/difficulty "quick actions" cluster and its state read.

import { http } from './http';
import type { GameruleKey, WorldState, RunQuickResult } from '../../../shared/types/world-controls';

export type { GameruleKey, WorldState, RunQuickResult };

interface WorldStateResponse {
  ok: true;
  running: boolean;
  state: WorldState;
}

interface RunQuickResponse extends RunQuickResult {
  ok: true;
}

export const worldControlsApi = {
  state: (serverId: string) => http.get<WorldStateResponse>(`/api/servers/${serverId}/world/state`),
  // `action` matches a key of QUICK_ACTIONS (backend/src/world-controls/world-controls.constants.ts)
  // — the backend has no exported literal union for it (just a `z.enum` over
  // `Object.keys(...)`), so this stays a plain string rather than inventing one.
  quick: (serverId: string, action: string) =>
    http.post<RunQuickResponse>(`/api/servers/${serverId}/world/quick`, { action }),
};
