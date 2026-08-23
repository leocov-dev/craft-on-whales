/** `GET /api/backups`'s per-item shape (global, cross-server list). */
export interface BackupRow {
  id: string;
  serverId: string;
  server: string;
  file: string;
  size: number;
  reason: string;
  ts: string;
}

/** `GET /api/servers/:id/backups`'s per-item shape (server-scoped, no `server`/`serverId`). */
export interface ServerBackupRow {
  id: string;
  file: string;
  size: number;
  reason: string;
  ts: string;
}
