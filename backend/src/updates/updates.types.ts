export interface UpdateFinding {
  server: string;
  kind: 'pack' | 'mod';
  subject: string;
  current: string | null;
  latest: string | null;
}

export interface OutdatedRow {
  serverId: string;
  server: string;
  kind: string;
  subject: string;
  current: string | null;
  latest: string | null;
  versionId?: string | null;
  contentId?: string;
  changelogUrl: string | null;
}
