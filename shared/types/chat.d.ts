export type ChatColor =
  | 'black'
  | 'dark_blue'
  | 'dark_green'
  | 'dark_aqua'
  | 'dark_red'
  | 'dark_purple'
  | 'gold'
  | 'gray'
  | 'dark_gray'
  | 'blue'
  | 'green'
  | 'aqua'
  | 'red'
  | 'light_purple'
  | 'yellow'
  | 'white';

/** `POST /api/servers/:id/chat` request body. */
export interface ChatSendInput {
  mode?: 'tellraw' | 'say';
  target?: string;
  text: string;
  color?: ChatColor;
  bold?: boolean;
  italic?: boolean;
  underlined?: boolean;
  strikethrough?: boolean;
  obfuscated?: boolean;
}

/** `GET /api/servers/:id/chat/history`'s entry shape. */
export interface ChatHistoryEntry {
  ts: string;
  actor: string;
  mode: 'tellraw' | 'say';
  target: string;
  text: string;
  color?: ChatColor;
  bold?: boolean;
  italic?: boolean;
  underlined?: boolean;
  strikethrough?: boolean;
  obfuscated?: boolean;
}
