// Wraps the global /api/worlds library endpoints (src/web/routes/worlds.ts).

import { http } from './http';
import type { LibraryWorld, SimpleWorld } from '../../../shared/types/worlds';

export type { LibraryWorld, SimpleWorld };

interface WorldsResponse {
  ok: true;
  worlds: LibraryWorld[];
}

interface WorldResponse {
  ok: true;
  world: SimpleWorld;
}

interface InstallResponse {
  ok: true;
  requiresConfirm?: boolean;
  warnings?: string[];
  [key: string]: unknown;
}

export const worldsApi = {
  list: () => http.get<WorldsResponse>('/api/worlds/'),
  downloadUrl: (id: string) => `/api/worlds/${id}/download`,
  rename: (id: string, name: string) =>
    http.patch<{ ok: true; world: { id: string; name: string } }>(`/api/worlds/${id}`, { name }),
  remove: (id: string) => http.delete<{ ok: true }>(`/api/worlds/${id}`),
  install: (
    id: string,
    serverId: string,
    mode: 'replace' | 'alongside' = 'replace',
    confirm = false,
  ) => http.post<InstallResponse>(`/api/worlds/${id}/install`, { serverId, mode, confirm }),
  extract: (serverId: string, name?: string) =>
    http.post<WorldResponse>('/api/worlds/extract', { serverId, name }),

  async upload(file: File, name?: string): Promise<WorldResponse> {
    const formData = new FormData();
    formData.append('file', file);
    if (name) formData.append('name', name);
    const res = await fetch('/api/worlds/upload', {
      method: 'POST',
      credentials: 'include',
      body: formData,
    });
    const json = (await res.json()) as { ok: boolean; error?: string } | WorldResponse;
    if (!res.ok || !json.ok) throw new Error(('error' in json && json.error) || 'Upload failed');
    return json as WorldResponse;
  },
};
