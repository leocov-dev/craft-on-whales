// Wraps GET /status/api/:slug — the public, unauthenticated status page
// (src/web/routes/status.ts, mounted before requireAuth).

import { http } from './http';
import type { StatusPageData } from '../../../shared/types/status';

export type { StatusPageData };

export const statusApi = {
  get: (slug: string) => http.get<{ ok: true; page: StatusPageData }>(`/status/api/${slug}`),
};
