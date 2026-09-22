/** `GET /api/updates`'s per-item shape. */
export interface OutdatedRow {
  serverId: string;
  server: string;
  kind: string;
  subject: string;
  current: string | null;
  latest: string | null;
  versionId?: string | null;
  contentId?: string;
  changelog: string | null;
  /** update_checks composite key — what an ignore/un-ignore call targets. */
  subjectType: 'pack' | 'content';
  subjectId: string;
}

export interface UpdateFinding {
  server: string;
  kind: 'pack' | 'mod';
  subject: string;
  current: string | null;
  latest: string | null;
}
