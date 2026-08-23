// Wraps /api/servers/:id/integrations (src/web/routes/integrations.ts).

import { http } from './http';
import type {
  EventToggles,
  DiscordConfig,
  SetDiscordConfigInput,
  StatusPageConfig,
  InviteInfo,
} from '../../../shared/types/integrations';

export type { EventToggles, DiscordConfig, SetDiscordConfigInput, StatusPageConfig, InviteInfo };

interface IntegrationsResponse {
  ok: true;
  discord: DiscordConfig;
  statusPage: StatusPageConfig;
  invite: InviteInfo | null;
}

export const integrationsApi = {
  get: (serverId: string) =>
    http.get<IntegrationsResponse>(`/api/servers/${serverId}/integrations`),
  saveDiscord: (serverId: string, input: SetDiscordConfigInput) =>
    http.post<{ ok: true; discord: DiscordConfig }>(
      `/api/servers/${serverId}/integrations/discord`,
      input,
    ),
  testDiscord: (serverId: string) =>
    http.post<{ ok: boolean; error?: string }>(
      `/api/servers/${serverId}/integrations/discord/test`,
    ),
  saveStatusPage: (serverId: string, input: { enabled: boolean; slug?: string | undefined }) =>
    http.post<{ ok: true; statusPage: StatusPageConfig }>(
      `/api/servers/${serverId}/integrations/status-page`,
      input,
    ),
};
