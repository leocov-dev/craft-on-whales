// Wraps POST /api/servers/:id/chat and GET /api/servers/:id/chat/history
// (src/web/routes/api.ts).

import { http } from './http';
import type { ChatColor, ChatSendInput, ChatHistoryEntry } from '../../../shared/types/chat';

export type { ChatColor, ChatSendInput, ChatHistoryEntry };

export const chatApi = {
  send: (serverId: string, input: ChatSendInput) =>
    http.post<{ ok: true }>(`/api/servers/${serverId}/chat`, input),
  history: (serverId: string, limit = 50) =>
    http.get<{ ok: true; history: ChatHistoryEntry[] }>(
      `/api/servers/${serverId}/chat/history?limit=${limit}`,
    ),
};
