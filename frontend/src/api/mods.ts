// Wraps /api/servers/:id/mods (+ pending-downloads, zip/.mrpack imports) in
// backend/src/mods/mods.controller.ts.

import { http } from './http';
import type {
  ContentItem,
  ContentKind,
  PendingDownload,
  ContentImportSummary,
  ContentImportReport,
  ContentImportRemoval,
  ContentImportSkipReason,
} from '../../../shared/types/mods';

export type {
  ContentItem,
  ContentKind,
  PendingDownload,
  ContentImportSummary,
  ContentImportReport,
  ContentImportRemoval,
  ContentImportSkipReason,
};

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
  /** Starts a zip / .mrpack import; poll the task, whose result is a ContentImportReport. */
  importPack: (serverId: string, file: File, applyOverrides: boolean) => {
    const form = new FormData();
    form.append('applyOverrides', String(applyOverrides));
    form.append('file', file);
    return http.postForm<{ ok: true; taskId: string }>(
      `/api/servers/${serverId}/mods/import`,
      form,
    );
  },
  listImports: (serverId: string) =>
    http.get<{ ok: true; imports: ContentImportSummary[] }>(
      `/api/servers/${serverId}/mods/imports`,
    ),
  deleteImport: (serverId: string, importId: string) =>
    http.delete<{ ok: true } & ContentImportRemoval>(
      `/api/servers/${serverId}/mods/imports/${encodeURIComponent(importId)}`,
    ),
};
