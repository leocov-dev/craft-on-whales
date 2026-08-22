'use strict';

// Admin chat: send styled messages to players over RCON — `tellraw` (per-target,
// full styling) or `say` (plain broadcast). The component builder and target
// validation are pure + exported for tests.

const { execCapture, inspectStatus } = require('../docker/containers') as typeof import('../docker/containers');
const { cleanText } = require('../utils/ansi') as typeof import('../utils/ansi');
const { recordEvent } = require('../events') as typeof import('../events');
const httpError = require('../utils/httpError') as typeof import('../utils/httpError');
const { PLAYER_NAME_RE } = require('../utils/playerName') as typeof import('../utils/playerName');

type ColorName =
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

type FormatFlag = 'bold' | 'italic' | 'underlined' | 'strikethrough' | 'obfuscated';

interface TextComponent {
  text: string;
  color?: ColorName;
  bold?: boolean;
  italic?: boolean;
  underlined?: boolean;
  strikethrough?: boolean;
  obfuscated?: boolean;
}

interface ChatOptions {
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

interface SentChatMessage {
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

// The 16 vanilla text colors → hex (also drives the UI swatches).
const COLORS: Record<ColorName, string> = {
  black: '#000000',
  dark_blue: '#0000AA',
  dark_green: '#00AA00',
  dark_aqua: '#00AAAA',
  dark_red: '#AA0000',
  dark_purple: '#AA00AA',
  gold: '#FFAA00',
  gray: '#AAAAAA',
  dark_gray: '#555555',
  blue: '#5555FF',
  green: '#55FF55',
  aqua: '#55FFFF',
  red: '#FF5555',
  light_purple: '#FF55FF',
  yellow: '#FFFF55',
  white: '#FFFFFF',
};
const FORMATS: FormatFlag[] = ['bold', 'italic', 'underlined', 'strikethrough', 'obfuscated'];

/** Build a tellraw JSON text component from text + style — pure, only sets chosen props. */
function buildComponent(opts: ChatOptions = {}): TextComponent {
  const c: TextComponent = { text: String(opts.text ?? '') };
  if (opts.color && Object.prototype.hasOwnProperty.call(COLORS, opts.color)) c.color = opts.color as ColorName;
  for (const f of FORMATS) if (opts[f]) c[f] = true;
  return c;
}

/** Validate a tellraw target: @a/@p/@r/@s or a Java username. Blocks entity selectors. */
function normalizeTarget(target: unknown): string {
  const t = String(target || '@a').trim();
  if (['@a', '@p', '@r', '@s'].includes(t)) return t;
  if (PLAYER_NAME_RE.test(t)) return t;
  throw httpError(400, 'Invalid recipient — pick Everyone or a valid player name');
}

async function assertRunning(serverId: string): Promise<void> {
  const info = await inspectStatus(serverId);
  if (!info.exists || !(info.status === 'running' || info.status === 'unhealthy')) {
    throw httpError(409, 'Start the server before sending chat');
  }
}

/** Send an admin chat message. Returns the sent message (for the panel's chat log). */
async function sendChat(
  serverId: string,
  opts: ChatOptions = {}
): Promise<SentChatMessage & { actor: string; ts: string }> {
  const text = String(opts.text || '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  if (!text) throw httpError(400, 'Message text is required');
  if (text.length > 512) throw httpError(400, 'Message is too long (512 chars max)');
  const mode = opts.mode === 'say' ? 'say' : 'tellraw';
  const actor = opts.actor || 'system';
  await assertRunning(serverId);

  let target = '@a';
  let cmd: string[];
  if (mode === 'say') {
    cmd = ['say', text];
  } else {
    target = normalizeTarget(opts.target);
    cmd = ['tellraw', target, JSON.stringify(buildComponent({ ...opts, text }))];
  }

  const out = cleanText(await execCapture(serverId, ['rcon-cli', ...cmd]));
  if (out.trim() && /Unknown or incomplete|Incorrect argument|Expected|No player was found|<--\[HERE\]/i.test(out)) {
    throw httpError(502, `The server rejected the message: ${out.split('\n')[0]}`);
  }

  const message: SentChatMessage = {
    mode,
    target,
    text,
    color: opts.color && Object.prototype.hasOwnProperty.call(COLORS, opts.color) ? (opts.color as ColorName) : null,
    bold: !!opts.bold,
    italic: !!opts.italic,
    underlined: !!opts.underlined,
    strikethrough: !!opts.strikethrough,
    obfuscated: !!opts.obfuscated,
  };
  // Full style flags in the event details: the panel's chat history replays
  // these events with a live tellraw preview, so the styling must round-trip.
  recordEvent({
    serverId,
    actor,
    type: 'chat-sent',
    summary: `Chat (${mode}) → ${target}: ${text.slice(0, 80)}`,
    details: { ...message, text: text.slice(0, 300) },
  });
  return { ...message, actor, ts: new Date().toISOString() };
}

export = { sendChat, buildComponent, normalizeTarget, COLORS, FORMATS };
