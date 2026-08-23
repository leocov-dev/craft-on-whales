export type ColorName =
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

export type FormatFlag = 'bold' | 'italic' | 'underlined' | 'strikethrough' | 'obfuscated';

export interface TextComponent {
  text: string;
  color?: ColorName;
  bold?: boolean;
  italic?: boolean;
  underlined?: boolean;
  strikethrough?: boolean;
  obfuscated?: boolean;
}

export interface ChatOptions {
  text?: string;
  mode?: 'say' | 'tellraw';
  actor?: string;
  target?: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underlined?: boolean;
  strikethrough?: boolean;
  obfuscated?: boolean;
}

export interface SentChatMessage {
  mode: 'say' | 'tellraw';
  target: string;
  text: string;
  color: ColorName | null;
  bold: boolean;
  italic: boolean;
  underlined: boolean;
  strikethrough: boolean;
  obfuscated: boolean;
}

export type ChatAction = 'rtp' | 'structure' | 'biome' | 'console';
export type ChatPermission = 'everyone' | 'whitelist' | 'ops';

/** Loose per-action parameter bag: only the fields relevant to `action` are set. */
export interface ActionParams {
  minDistance?: number;
  maxDistance?: number;
  center?: 'origin' | 'player';
  structure?: string;
  random?: boolean;
  biome?: string;
  commands?: string[];
}

export interface HydratedCommand {
  id: string;
  serverId: string;
  trigger: string;
  description: string;
  action: ChatAction;
  params: ActionParams;
  permission: ChatPermission;
  cooldownSec: number;
  enabled: boolean;
  uses: number;
  lastUsedAt: string | null;
  createdAt: string;
  msgPending: string | null;
  msgSuccess: string | null;
  msgFailure: string | null;
}

export interface CommandSpec {
  trigger: string;
  description: string;
  action: ChatAction;
  params: ActionParams;
  permission: ChatPermission;
  cooldownSec: number;
  msgPending: string | null;
  msgSuccess: string | null;
  msgFailure: string | null;
}

export interface ValidateSpecInput {
  trigger: unknown;
  description?: unknown;
  action: ChatAction;
  params?: ActionParams | Record<string, unknown>;
  permission: ChatPermission;
  cooldownSec: unknown;
  msgPending?: unknown;
  msgSuccess?: unknown;
  msgFailure?: unknown;
}

export type CommandChanges = Partial<ValidateSpecInput> & { enabled?: boolean };

/** Result fields an executed action may report — feeds resultVars()'s templates. */
export interface ActionResult {
  x?: number;
  y?: number;
  z?: number;
  distance?: number;
  dimension?: string | null;
  structure?: string;
  biome?: string;
  commands?: number;
  output?: string;
}

/** Matches the `{ running?, actor? }` third/fourth arg shared by players services' mutators. */
export interface RunOptions {
  running?: boolean;
  actor?: string;
}

export interface ExecuteActionResult {
  message: string;
  result: ActionResult;
}
