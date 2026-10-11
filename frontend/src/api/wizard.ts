// Wraps GET /api/versions, GET /api/ports/suggest, POST /api/servers and
// POST /api/servers/from-zip for the create-server flows.

import { http } from './http';
import type {
  MojangVersionEntry,
  SuggestedPorts,
  CreateServerInput,
  CreatedServerSummary,
} from '../../../shared/types/wizard';
import type {
  ServerFromZipPreview,
  ServerFromZipResult,
  ZipServerTarget,
} from '../../../shared/types/mods';
import type { ZipLoaderChoice } from '../utils/zip-server';

export type {
  MojangVersionEntry,
  SuggestedPorts,
  CreateServerInput,
  CreatedServerSummary,
  ServerFromZipPreview,
  ServerFromZipResult,
  ZipServerTarget,
};

interface CreateServerResponse {
  ok: true;
  server: CreatedServerSummary;
}

export interface FromZipInput {
  name: string;
  /** Token from `previewZip`; stands in for the file. */
  uploadToken?: string | undefined;
  /** Shown in the task label when a token stands in for the file. */
  archiveName?: string | undefined;
  loader: ZipLoaderChoice;
  /** Omitted: read from the archive. */
  mcVersion?: string | undefined;
  applyOverrides: boolean;
  portGame?: number | undefined;
  diskQuotaGb?: number;
  heapMb?: number;
  containerMemoryMb?: number;
}

export const wizardApi = {
  versions: (includeSnapshots = false) =>
    http.get<{ ok: true; versions: MojangVersionEntry[] }>(
      `/api/versions?snapshots=${includeSnapshots}`,
    ),
  suggestPorts: () => http.get<{ ok: true; ports: SuggestedPorts }>('/api/ports/suggest'),
  checkPort: (port: number) =>
    http.get<{ ok: true; port: number; free: boolean }>(`/api/ports/check?port=${port}`),
  create: (input: CreateServerInput) => http.post<CreateServerResponse>('/api/servers', input),
  /** Analyse an archive. Upload `file` once; later calls pass the returned token instead. */
  previewZip: (
    src: File | { uploadToken: string },
    opts: { loader: ZipLoaderChoice; mcVersion?: string | undefined },
  ) => {
    const form = new FormData();
    form.append('loader', opts.loader);
    if (opts.mcVersion) form.append('mcVersion', opts.mcVersion);
    if ('uploadToken' in src) form.append('uploadToken', src.uploadToken);
    else form.append('file', src);
    return http.postForm<{ ok: true; preview: ServerFromZipPreview; uploadToken: string }>(
      '/api/servers/from-zip/preview',
      form,
    );
  },
  discardZipPreview: (uploadToken: string) =>
    http.delete<{ ok: true }>(`/api/servers/from-zip/preview/${encodeURIComponent(uploadToken)}`),
  /** Starts the create-from-zip task; poll it, its result is a ServerFromZipResult. */
  fromZip: (input: FromZipInput, file?: File) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined && value !== '') form.append(key, String(value));
    }
    if (file) form.append('file', file);
    return http.postForm<{ ok: true; taskId: string }>('/api/servers/from-zip', form);
  },
};
