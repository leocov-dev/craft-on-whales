// Wraps the file manager routes in src/web/routes/files.ts's makeRouter()
// factory — shared shape for both the global manager (/api/files, admin-only)
// and the per-server manager (/api/servers/:id/files, admin+operator).

import { http } from './http';
import type { FileEntry } from '../../../shared/types/files';

export type { FileEntry };

interface ListResponse {
  ok: true;
  path: string;
  entries: FileEntry[];
}

interface ReadResponse {
  ok: true;
  path: string;
  content: string;
  size: number;
}

function qs(path: string): string {
  return `?path=${encodeURIComponent(path)}`;
}

export interface FilesApi {
  list: (path: string) => Promise<ListResponse>;
  read: (path: string) => Promise<ReadResponse>;
  downloadUrl: (path: string) => string;
  write: (path: string, content: string) => Promise<{ ok: true; path: string; size: number }>;
  mkdir: (path: string) => Promise<{ ok: true; path: string }>;
  rename: (path: string, newName: string) => Promise<{ ok: true; path: string }>;
  move: (path: string, dest: string) => Promise<{ ok: true; path: string }>;
  copy: (path: string, dest: string) => Promise<{ ok: true; path: string; sizeBytes: number }>;
  remove: (path: string) => Promise<{ ok: true; freedBytes: number }>;
  upload: (
    path: string,
    files: File[],
  ) => Promise<{ ok: true; uploaded: { path: string; name: string; size: number }[] }>;
}

export function createFilesApi(base: string): FilesApi {
  return {
    list: (path) => http.get<ListResponse>(`${base}/list${qs(path)}`),
    read: (path) => http.get<ReadResponse>(`${base}/read${qs(path)}`),
    downloadUrl: (path) => `${base}/download${qs(path)}`,
    write: (path, content) => http.post(`${base}/write`, { path, content }),
    mkdir: (path) => http.post(`${base}/mkdir`, { path }),
    rename: (path, newName) => http.post(`${base}/rename`, { path, newName }),
    move: (path, dest) => http.post(`${base}/move`, { path, dest }),
    copy: (path, dest) => http.post(`${base}/copy`, { path, dest }),
    remove: (path) => http.delete(`${base}${qs(path)}`),
    async upload(path, files) {
      const formData = new FormData();
      for (const f of files) formData.append('files', f);
      const res = await fetch(`${base}/upload${qs(path)}`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        uploaded?: { path: string; name: string; size: number }[];
      };
      if (!res.ok || !json.ok) throw new Error(json.error || 'Upload failed');
      return json as { ok: true; uploaded: { path: string; name: string; size: number }[] };
    },
  };
}

export const filesApi = createFilesApi('/api/files');
export const serverFilesApi = (serverId: string) =>
  createFilesApi(`/api/servers/${serverId}/files`);
