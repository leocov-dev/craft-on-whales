// Wraps /api/blueprints (src/web/routes/blueprints.ts).

import { http } from './http';
import type { BlueprintViewModel, BlueprintManifest, ImportPreview } from '../../../shared/types/blueprints';

export type { BlueprintViewModel, BlueprintManifest, ImportPreview };

interface BlueprintsResponse {
  ok: true;
  blueprints: BlueprintViewModel[];
}

interface ImportPreviewResponse {
  ok: true;
  preview: ImportPreview;
  uploadToken?: string;
  blueprintId?: string;
}

interface ImportResponse {
  ok: true;
  server: { id: string; name: string; type: string; mcVersion: string; portGame: number } | null;
  report: { message: string; level?: string }[];
}

export const blueprintsApi = {
  list: () => http.get<BlueprintsResponse>('/api/blueprints'),
  downloadUrl: (id: string) => `/api/blueprints/${id}/download`,
  remove: (id: string) => http.delete<{ ok: true }>(`/api/blueprints/${id}`),
  create: (blueprintId: string) =>
    http.post<ImportResponse>('/api/blueprints/import', { blueprintId }),
  importWithToken: (uploadToken: string) =>
    http.post<ImportResponse>('/api/blueprints/import', { uploadToken }),

  async previewUpload(file: File): Promise<ImportPreviewResponse> {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/blueprints/import-preview', {
      method: 'POST',
      credentials: 'include',
      body: formData,
    });
    const json = (await res.json()) as { ok: boolean; error?: string } | ImportPreviewResponse;
    if (!res.ok || !json.ok) throw new Error(('error' in json && json.error) || 'Preview failed');
    return json as ImportPreviewResponse;
  },
};
