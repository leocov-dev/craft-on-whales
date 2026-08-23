/** One entry from `GET /api/files/list` or `GET /api/servers/:id/files/list`. */
export interface FileEntry {
  name: string;
  dir: boolean;
  size: number;
  mtimeMs: number;
  mtime: string;
  path: string;
}
