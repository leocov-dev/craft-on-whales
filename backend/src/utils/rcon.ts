import { ContainerService } from '../docker/container.service';
import { cleanText, stripAnsi } from './ansi';

export interface RconOptions {
  timeoutMs?: number;
  /** 'full' strips ANSI + Minecraft § codes (default, safe for parsing/display).
   *  'ansi-only' keeps § codes (console UI wants to render MC color).
   *  'raw' does neither (output is discarded by the caller). */
  clean?: 'full' | 'ansi-only' | 'raw';
}

/**
 * Run an `rcon-cli` command inside a server's container. `--` is always
 * inserted before args so a leading `-` (negative coords, names) can never
 * be eaten as an rcon-cli flag — harmless for commands that never start with
 * one, so it's applied unconditionally rather than per-call.
 */
export async function rcon(
  containers: ContainerService,
  serverId: string,
  args: (string | number)[],
  opts: RconOptions = {},
): Promise<string> {
  const { timeoutMs, clean = 'full' } = opts;
  const out = await containers.execCapture(
    serverId,
    ['rcon-cli', '--', ...args.map(String)],
    timeoutMs ? { timeoutMs } : {},
  );
  const trimmed = String(out || '').trim();
  if (clean === 'ansi-only') return stripAnsi(trimmed);
  if (clean === 'raw') return trimmed;
  return cleanText(trimmed);
}
