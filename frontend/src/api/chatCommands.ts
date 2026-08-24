// Wraps /api/servers/:id/chat-commands (src/web/routes/chatCommands.ts).

import { http } from './http';
import type {
  CommandAction,
  CommandPermission,
  ChatCommand,
  ChatCommandInput,
} from '../../../shared/types/chat-commands';

export type { CommandAction, CommandPermission, ChatCommand, ChatCommandInput };

interface ListResponse {
  ok: true;
  prefix: string;
  commands: ChatCommand[];
  stats: { total: number; enabled: number; uses: number };
}

export const chatCommandsApi = {
  list: (serverId: string) => http.get<ListResponse>(`/api/servers/${serverId}/chat-commands/`),
  create: (serverId: string, input: ChatCommandInput) =>
    http.post<{ ok: true; command: ChatCommand }>(`/api/servers/${serverId}/chat-commands/`, input),
  update: (serverId: string, cmdId: string, input: Partial<ChatCommandInput>) =>
    http.patch<{ ok: true; command: ChatCommand }>(
      `/api/servers/${serverId}/chat-commands/${cmdId}`,
      input,
    ),
  remove: (serverId: string, cmdId: string) =>
    http.delete<{ ok: true }>(`/api/servers/${serverId}/chat-commands/${cmdId}`),
  test: (serverId: string, cmdId: string, player: string) =>
    http.post<{ ok: true }>(`/api/servers/${serverId}/chat-commands/${cmdId}/test`, { player }),
  setPrefix: (serverId: string, prefix: string) =>
    http.put<{ ok: true; prefix: string }>(`/api/servers/${serverId}/chat-commands/prefix`, {
      prefix,
    }),
};
