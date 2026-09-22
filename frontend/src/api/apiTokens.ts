// Wraps the admin-only /api/api-tokens routes (backend/src/api-tokens/api-tokens.controller.ts).

import { http } from './http';

export interface ApiTokenSummary {
  id: string;
  label: string;
  createdBy: string;
  serverIds: string[] | null; // null = all servers
  expiresAt: string | null;
  revoked: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ApiTokensList {
  ok: true;
  enabled: boolean;
  tokens: ApiTokenSummary[];
}

export const apiTokensApi = {
  list: () => http.get<ApiTokensList>('/api/api-tokens'),
  setEnabled: (enabled: boolean) =>
    http.post<{ ok: true; enabled: boolean }>('/api/api-tokens/enabled', { enabled }),
  create: (input: { label: string; serverIds: string[] | null; expiresAt: string | null }) =>
    http.post<{ ok: true; token: string; summary: ApiTokenSummary }>('/api/api-tokens', input),
  revoke: (id: string) => http.delete<{ ok: true }>(`/api/api-tokens/${id}`),
};
