// Wraps GET /api/events (paginated/filtered activity feed) and the excerpt/export
// routes in src/web/routes/api.ts.

import { http } from './http';
import type { EventViewModel, EventsFilters } from '../../../shared/types/events';

export type { EventViewModel, EventsFilters };

interface EventsResponse {
  ok: true;
  events: EventViewModel[];
  types: string[];
  filters: { q: string; server: string; type: string };
  total: number;
  page: number;
  pages: number;
  perPage: number;
}

function buildQuery(filters: EventsFilters): string {
  const params = new URLSearchParams();
  if (filters.q) params.set('q', filters.q);
  if (filters.server) params.set('server', filters.server);
  if (filters.type) params.set('type', filters.type);
  if (filters.page) params.set('page', String(filters.page));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export const eventsApi = {
  list: (filters: EventsFilters = {}) =>
    http.get<EventsResponse>(`/api/events${buildQuery(filters)}`),
  excerptUrl: (id: number) => `/api/events/${id}/excerpt`,
  exportUrl: (format: 'csv' | 'json', filters: EventsFilters = {}) => {
    const base = buildQuery(filters);
    const sep = base ? '&' : '?';
    return `/api/events/export${base}${sep}format=${format}`;
  },
};
