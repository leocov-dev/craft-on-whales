// Wraps GET /api/versions, GET /api/ports/suggest, and POST /api/servers
// (src/web/routes/api.ts) for the create-server wizard.

import { http } from './http';
import type {
  MojangVersionEntry,
  SuggestedPorts,
  CreateServerInput,
  CreatedServerSummary,
} from '../../../shared/types/wizard';

export type { MojangVersionEntry, SuggestedPorts, CreateServerInput, CreatedServerSummary };

interface CreateServerResponse {
  ok: true;
  server: CreatedServerSummary;
}

export const wizardApi = {
  versions: (includeSnapshots = false) =>
    http.get<{ ok: true; versions: MojangVersionEntry[] }>(
      `/api/versions?snapshots=${includeSnapshots}`,
    ),
  suggestPorts: () => http.get<{ ok: true; ports: SuggestedPorts }>('/api/ports/suggest'),
  create: (input: CreateServerInput) => http.post<CreateServerResponse>('/api/servers', input),
};
