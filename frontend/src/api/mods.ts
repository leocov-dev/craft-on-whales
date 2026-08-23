// Wraps /api/servers/:id/mods (+ pending-downloads) in src/web/routes/api.ts.

import { http } from './http';
import type { ContentItem, ContentKind, PendingDownload } from '../../../shared/types/mods';

export type { ContentItem, ContentKind, PendingDownload };

export const modsApi = {
  list: (serverId: string) =>
    http.get<{ ok: true; mods: ContentItem[] }>(`/api/servers/${serverId}/mods`),
  addByUrl: (serverId: string, url: string, kind?: ContentItem['kind']) =>
    http.post<{ ok: true; installed: { name: string; filename: string; version: string | null } }>(
      `/api/servers/${serverId}/mods`,
      { url, kind },
    ),
  update: (serverId: string, contentId: string) =>
    http.post<{ ok: true; installed: unknown }>(`/api/servers/${serverId}/mods/update`, {
      contentId,
    }),
  toggle: (serverId: string, file: string, enabled: boolean) =>
    http.post<{ ok: true; applied: 'instant' | 'on-restart' }>(
      `/api/servers/${serverId}/mods/toggle`,
      { file, enabled },
    ),
  remove: (serverId: string, file: string) =>
    http.delete<{ ok: true; freedBytes: number }>(
      `/api/servers/${serverId}/mods/${encodeURIComponent(file)}`,
    ),
  pendingDownloads: (serverId: string) =>
    http.get<{ ok: true; mods: PendingDownload[] }>(`/api/servers/${serverId}/pending-downloads`),
  excludePending: (serverId: string, filename: string) =>
    http.post<{ ok: true; mods: PendingDownload[] }>(
      `/api/servers/${serverId}/pending-downloads/exclude`,
      { filename },
    ),
};
