import type {
  EventToggles,
  DiscordConfig,
  SetDiscordConfigInput,
  InviteInfo,
} from '../../../shared/types/integrations';

export type { EventToggles, DiscordConfig, InviteInfo };
export type SetDiscordConfigOptions = SetDiscordConfigInput;

export type NotificationKind =
  'crash' | 'start' | 'stop' | 'backup' | 'update' | 'player';

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface EmbedPayload {
  title?: string;
  description?: string;
  fields?: EmbedField[];
}

export interface GenerateMrpackResult {
  absPath: string;
  filename: string;
  fileCount: number;
  manual: string[];
}
