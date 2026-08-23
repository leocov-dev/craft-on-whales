/** `GET /api/servers/:id/crashes`'s listing entry — the crash_reports row plus a parsed `suspected` array. */
export interface CrashReport {
  id: string;
  server_id: string;
  filename: string;
  file_mtime: string;
  size_bytes: number;
  summary: string;
  exception: string;
  suspected_json: string;
  suspected: string[];
  event_id: number | null;
  /** 0 | 1 — raw SQLite integer, not a JSON boolean (matches the legacy wire shape). */
  viewed: number;
  created_at: string;
}
