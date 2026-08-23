/** `GET /api/worlds/`'s library listing entry. */
export interface LibraryWorld {
  id: string;
  name: string;
  filename: string;
  source: string;
  sourceKind: 'import' | 'upload' | 'extract';
  flavor: string | null;
  mcVersion: string | null;
  size: number;
  created: string;
  createdMs: number | null;
  hash: string;
}

/** The lighter shape `POST /api/worlds/upload` and `POST /api/worlds/extract` return. */
export interface SimpleWorld {
  id: string;
  name: string;
  filename: string;
  size: number;
  flavor: string | null;
  mcVersion: string | null;
  // Raw `library_files.world_source` ('upload' | 'extract:<id>' | 'import' |
  // null) — unlike LibraryWorld's `source`, this is never given a fallback,
  // so it's genuinely nullable on rows written before that column existed.
  source: string | null;
  created: string;
}
