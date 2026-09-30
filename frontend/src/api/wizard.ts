// Wraps GET /api/versions, GET /api/ports/suggest, POST /api/servers and
// POST /api/servers/from-zip for the create-server flows.

import { http } from './http';
import type {
  MojangVersionEntry,
  SuggestedPorts,
  CreateServerInput,
  CreatedServerSummary,
} from '../../../shared/types/wizard';
import type { ServerFromZipResult, ZipServerTarget } from '../../../shared/types/mods';
import type { ZipLoaderChoice } from '../utils/zip-server';

export type {
  MojangVersionEntry,
  SuggestedPorts,
  CreateServerInput,
  CreatedServerSummary,
  ServerFromZipResult,
  ZipServerTarget,
};

interface CreateServerResponse {
  ok: true;
  server: CreatedServerSummary;
}

export interface FromZipInput {
  name: string;
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
  /** Starts the create-from-zip task; poll it, its result is a ServerFromZipResult. */
  fromZip: (file: File, input: FromZipInput) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined && value !== '') form.append(key, String(value));
    }
    form.append('file', file);
    return http.postForm<{ ok: true; taskId: string }>('/api/servers/from-zip', form);
  },
};
