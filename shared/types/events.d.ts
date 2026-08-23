/** The event view model returned by `GET /api/events` and used throughout the activity feed. */
export interface EventViewModel {
  id: number;
  serverId: string | null;
  server: string;
  type: string;
  actor: string;
  ts: string;
  summary: string;
  hasLog: boolean;
  diff: unknown;
}

export interface EventsFilters {
  q?: string;
  server?: string;
  type?: string;
  page?: number;
}
