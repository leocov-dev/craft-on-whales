export type ContentKind = 'mod' | 'plugin' | 'datapack' | 'resourcepack';

/** `GET /api/servers/:id/mods` row shape. */
export interface ContentItem {
  id: string | null;
  name: string;
  file: string;
  kind: ContentKind;
  source: string;
  version: string | null;
  size: number;
  enabled: boolean;
  disabledVia?: null;
  missing?: boolean;
  sharedWith: number | null;
  iconUrl: string | null;
  updateAvailable?: string | null;
}

/** `GET /api/servers/:id/pending-downloads` row shape. */
export interface PendingDownload {
  name: string;
  versionName: string;
  filename: string;
  url: string;
  slug: string | null;
  fileId: string | null;
}
