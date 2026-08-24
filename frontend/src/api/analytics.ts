// Wraps /api/servers/:id/analytics (src/web/routes/analytics.ts). Scoped down
// to timeline + scoreboard for the first pass — profile/xray drill-down is a
// follow-up once the basics are proven out.

import { http } from './http';
import type {
  TimelineEvent,
  ScoreboardMetric,
  ScoreboardRow,
} from '../../../shared/types/analytics';

export type { TimelineEvent, ScoreboardMetric, ScoreboardRow };

interface TimelineResponse {
  ok: true;
  events: TimelineEvent[];
  nextBefore: number | null;
}

interface ScoreboardResponse {
  ok: true;
  metric: string;
  window: string;
  rows: ScoreboardRow[];
}

export const analyticsApi = {
  timeline: (
    serverId: string,
    opts: { type?: string; player?: string; limit?: number; before?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.type) params.set('type', opts.type);
    if (opts.player) params.set('player', opts.player);
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.before) params.set('before', String(opts.before));
    const qs = params.toString();
    return http.get<TimelineResponse>(
      `/api/servers/${serverId}/analytics/timeline${qs ? `?${qs}` : ''}`,
    );
  },
  scoreboard: (
    serverId: string,
    metric: ScoreboardMetric = 'playtimeTicks',
    window: 'all' | '7d' | '24h' = 'all',
  ) =>
    http.get<ScoreboardResponse>(
      `/api/servers/${serverId}/analytics/scoreboard?metric=${metric}&window=${window}`,
    ),
  ingestNow: (serverId: string) =>
    http.post<{ ok: true; events: number; players: number; snapshots: number }>(
      `/api/servers/${serverId}/analytics/ingest-now`,
    ),
};
