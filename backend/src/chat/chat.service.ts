import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { ContainerService } from '../docker/container.service';
import { EventsService } from '../events/events.service';
import { cleanText } from '../utils/ansi';
import { PLAYER_NAME_RE } from '../utils/player-name';
import type {
  ChatOptions,
  ColorName,
  FormatFlag,
  SentChatMessage,
  TextComponent,
} from './chat.types';

// The 16 vanilla text colors → hex (also drives the UI swatches).
export const COLORS: Record<ColorName, string> = {
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
export const FORMATS: FormatFlag[] = [
  'bold',
  'italic',
  'underlined',
  'strikethrough',
  'obfuscated',
];

/**
 * Admin chat: send styled messages to players over RCON — `tellraw` (per-target,
 * full styling) or `say` (plain broadcast). Ports `src/services/chat.ts`.
 */
@Injectable()
export class ChatService {
  constructor(
    private readonly containers: ContainerService,
    private readonly events: EventsService,
  ) {}

  /** Build a tellraw JSON text component from text + style — pure, only sets chosen props. */
  buildComponent(opts: ChatOptions = {}): TextComponent {
    const c: TextComponent = { text: String(opts.text ?? '') };
    if (opts.color && Object.prototype.hasOwnProperty.call(COLORS, opts.color))
      c.color = opts.color as ColorName;
    for (const f of FORMATS) if (opts[f]) c[f] = true;
    return c;
  }

  /** Validate a tellraw target: @a/@p/@r/@s or a Java username. Blocks entity selectors. */
  normalizeTarget(target: unknown): string {
    const t = String(target || '@a').trim();
    if (['@a', '@p', '@r', '@s'].includes(t)) return t;
    if (PLAYER_NAME_RE.test(t)) return t;
    throw new BadRequestException(
      'Invalid recipient — pick Everyone or a valid player name',
    );
  }

  private async assertRunning(serverId: string): Promise<void> {
    const info = await this.containers.inspectStatus(serverId);
    if (
      !info.exists ||
      !(info.status === 'running' || info.status === 'unhealthy')
    ) {
      throw new ConflictException('Start the server before sending chat');
    }
  }

  /** Send an admin chat message. Returns the sent message (for the panel's chat log). */
  async sendChat(
    serverId: string,
    opts: ChatOptions = {},
  ): Promise<SentChatMessage & { actor: string; ts: string }> {
    const text = String(opts.text || '')
      .replace(/[\r\n]+/g, ' ')
      .trim();
    if (!text) throw new BadRequestException('Message text is required');
    if (text.length > 512)
      throw new BadRequestException('Message is too long (512 chars max)');
    const mode = opts.mode === 'say' ? 'say' : 'tellraw';
    const actor = opts.actor || 'system';
    await this.assertRunning(serverId);

    let target = '@a';
    let cmd: string[];
    if (mode === 'say') {
      cmd = ['say', text];
    } else {
      target = this.normalizeTarget(opts.target);
      cmd = [
        'tellraw',
        target,
        JSON.stringify(this.buildComponent({ ...opts, text })),
      ];
    }

    const out = cleanText(
      await this.containers.execCapture(serverId, ['rcon-cli', ...cmd]),
    );
    if (
      out.trim() &&
      /Unknown or incomplete|Incorrect argument|Expected|No player was found|<--\[HERE\]/i.test(
        out,
      )
    ) {
      throw new HttpException(
        `The server rejected the message: ${out.split('\n')[0]}`,
        502,
      );
    }

    const message: SentChatMessage = {
      mode,
      target,
      text,
      color:
        opts.color && Object.prototype.hasOwnProperty.call(COLORS, opts.color)
          ? (opts.color as ColorName)
          : null,
      bold: !!opts.bold,
      italic: !!opts.italic,
      underlined: !!opts.underlined,
      strikethrough: !!opts.strikethrough,
      obfuscated: !!opts.obfuscated,
    };
    // Full style flags in the event details: the panel's chat history replays
    // these events with a live tellraw preview, so the styling must round-trip.
    this.events.recordEvent({
      serverId,
      actor,
      type: 'chat-sent',
      summary: `Chat (${mode}) → ${target}: ${text.slice(0, 80)}`,
      details: { ...message, text: text.slice(0, 300) },
    });
    return { ...message, actor, ts: new Date().toISOString() };
  }
}
