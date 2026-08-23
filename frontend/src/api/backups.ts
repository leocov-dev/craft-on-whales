// Wraps GET /api/backups (global list) and the per-server create/restore
// task-based routes + admin/operator-only download in src/web/routes/api.ts.

import { http } from './http';
import type { BackupRow, ServerBackupRow } from '../../../shared/types/backups';

export type { BackupRow, ServerBackupRow };

interface BackupsResponse {
  ok: true;
  backups: BackupRow[];
  totals: { count: number; bytes: number };
}

interface TaskStartResponse {
  ok: true;
  taskId: string;
}

interface ServerBackupsResponse {
  ok: true;
  backups: ServerBackupRow[];
}

export const backupsApi = {
  list: () => http.get<BackupsResponse>('/api/backups'),
  listForServer: (serverId: string) =>
    http.get<ServerBackupsResponse>(`/api/servers/${serverId}/backups`),
  create: (serverId: string, note?: string) =>
    http.post<TaskStartResponse>(`/api/servers/${serverId}/backups`, note ? { note } : {}),
  restore: (serverId: string, backupId: string) =>
    http.post<TaskStartResponse>(`/api/servers/${serverId}/backups/${backupId}/restore`),
  downloadUrl: (backupId: string) => `/api/backups/${backupId}/download`,
  remove: (backupId: string) => http.delete<{ ok: true }>(`/api/backups/${backupId}`),
};
