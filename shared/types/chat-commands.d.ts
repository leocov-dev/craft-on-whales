export type CommandAction = 'rtp' | 'structure' | 'biome' | 'console';
export type CommandPermission = 'everyone' | 'whitelist' | 'ops';

/** `GET /api/servers/:id/chat-commands/`'s listing entry. */
export interface ChatCommand {
  id: string;
  server_id: string;
  trigger: string;
  description: string;
  action: CommandAction;
  params: {
    minDistance?: number;
    maxDistance?: number;
    center?: 'origin' | 'player';
    structure?: string;
    random?: boolean;
    biome?: string;
    commands?: string[];
  };
  permission: CommandPermission;
  cooldown_sec: number;
  enabled: boolean;
  uses: number;
  last_used_at: string | null;
  created_at: string;
  msg_pending: string | null;
  msg_success: string | null;
  msg_failure: string | null;
  actionSummary: string;
}

/** `POST`/`PATCH .../chat-commands` request body. */
export interface ChatCommandInput {
  trigger: string;
  description?: string;
  action: CommandAction;
  params?: Record<string, unknown>;
  permission?: CommandPermission;
  cooldownSec?: number;
  enabled?: boolean;
  msgPending?: string;
  msgSuccess?: string;
  msgFailure?: string;
}
