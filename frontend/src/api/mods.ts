// Wraps /api/servers/:id/mods (+ pending-downloads, zip/.mrpack imports) in
// backend/src/mods/mods.controller.ts.

import { ApiError, http } from './http';
import type {
  BlockedDownload,
  ContentInstallResult,
  ContentItem,
  ContentKind,
  PendingDownload,
  ContentImportSummary,
  ContentImportReport,
  ContentImportRemoval,
  ContentImportSkipReason,
} from '../../../shared/types/mods';

export type {
  BlockedDownload,
  ContentInstallResult,
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
  /** A 409 whose error carries `blocked` (see blockedDownloadOf) needs completeManual. */
  addByUrl: (serverId: string, url: string, kind?: ContentItem['kind']) =>
    http.post<{ ok: true; installed: ContentInstallResult }>(`/api/servers/${serverId}/mods`, {
      url,
      kind,
    }),
  /**
   * Finish a blocked add-by-link with the jar the user downloaded themselves.
   * For a blocked update, `url` is the update's `updateRef` and
   * `replaceContentId` the row it replaces.
   */
  completeManual: (
    serverId: string,
    url: string,
    file: File,
    {
      kind,
      replaceContentId,
    }: { kind?: ContentItem['kind']; replaceContentId?: string | undefined } = {},
  ) => {
    const form = new FormData();
    form.append('url', url);
    if (kind) form.append('kind', kind);
    if (replaceContentId) form.append('replaceContentId', replaceContentId);
    form.append('file', file);
    return http.postForm<{ ok: true; installed: ContentInstallResult; verified: boolean }>(
      `/api/servers/${serverId}/mods/manual`,
      form,
    );
  },
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

/** The BlockedDownload an add-by-link 409 carries, if that's what the error is. */
export function blockedDownloadOf(err: unknown): BlockedDownload | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const blocked = err.body?.blocked;
  return blocked && typeof blocked === 'object' ? (blocked as BlockedDownload) : null;
}

/**
 * A blocked update (POST mods/update 409): the BlockedDownload plus the pinned
 * link to complete it with through completeManual.
 */
export function blockedUpdateOf(err: unknown): { blocked: BlockedDownload; ref: string } | null {
  const blocked = blockedDownloadOf(err);
  const ref = err instanceof ApiError ? err.body?.updateRef : undefined;
  return blocked && typeof ref === 'string' ? { blocked, ref } : null;
}
