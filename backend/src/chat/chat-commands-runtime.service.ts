import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ContainerService } from '../docker/container.service';
import { EventsService } from '../events/events.service';
import { PlayerRosterService } from '../players/player-roster.service';
import { PlayerTeleportService } from '../players/player-teleport.service';
import { cleanText } from '../utils/ansi';
import { PLAYER_NAME_RE } from '../utils/player-name';
import {
  asString,
  TRIGGER_RE,
  ChatCommandsService,
} from './chat-commands.service';
import {
  ChatCommandsCacheService,
  type RuntimeEntry,
} from './chat-commands-cache.service';
import type {
  ActionResult,
  ExecuteActionResult,
  HydratedCommand,
  RunOptions,
} from './chat.types';

const PLAYER_RE = PLAYER_NAME_RE;
// Chat args substituted into console commands: strict shape or dropped.
const ARG_RE = /^[A-Za-z0-9_:\-.]{0,32}$/;
const WHISPER_MAX = 120;

const DIM_LABEL: Record<string, string> = {
  'minecraft:overworld': 'the Overworld',
  'minecraft:the_nether': 'the Nether',
  'minecraft:the_end': 'the End',
};

/**
 * Custom chat commands: runtime dispatch side. The owner registers triggers
 * like `rtp2` through `ChatCommandsService` (persistence/CRUD); when a player
 * types `!rtp2` in game chat the log ingester calls `handleChat()` here, which
 * looks the trigger up (via the shared `ChatCommandsCacheService`, rebuilt
 * from `ChatCommandsService.listCommands`/`getPrefix` on a miss) and runs the
 * bound action (panel RTP / structure tp / biome tp / raw console commands)
 * AS that player, with per-command permissions and cooldowns. Zero mods —
 * detection is log-based, execution is RCON-based.
 *
 * This used to live on one class together with the CRUD/prefix-management
 * side because both shared the same in-memory cache/cooldown/inflight maps
 * tightly enough (CRUD invalidates the cache this reads) that splitting felt
 * artificial. That cache is now `ChatCommandsCacheService`, injected into
 * both this service and `ChatCommandsService` instead of either depending on
 * the other directly — every CRUD write still invalidates the entry this
 * service reads, exactly as before. The cooldown/inflight/throttle maps below
 * are runtime-only state and stay local to this class.
 *
 * `isOp`/`isWhitelisted` reuse `PlayerRosterService.listPlayers()` (which
 * already aggregates ops.json/whitelist.json/banned-players.json/
 * usercache.json into one roster) rather than reaching into its private
 * per-file readJson — a few extra file reads per permission check, traded
 * for not exposing file-format internals across the module boundary.
 */
@Injectable()
export class ChatCommandsRuntimeService {
  private readonly cooldowns = new Map<string, number>(); // `${serverId}:${trigger}:${playerLower}` -> last run ts
  private readonly inflight = new Set<string>(); // `${serverId}:${playerLower}` — one execution per player
  private readonly triggerThrottle = new Map<string, number>(); // `${serverId}:${playerLower}` -> last-processed ts (spam guard)
  private static readonly THROTTLE_MS = 400;

  constructor(
    private readonly commands: ChatCommandsService,
    private readonly runtimeCache: ChatCommandsCacheService,
    private readonly events: EventsService,
    private readonly containers: ContainerService,
    private readonly roster: PlayerRosterService,
    private readonly teleport: PlayerTeleportService,
  ) {}

  // -------------------------------------------------------------------------
  // Runtime: cache, cooldowns, concurrency

  private async getRuntime(serverId: string): Promise<RuntimeEntry> {
    const hit = this.runtimeCache.get(serverId);
    if (hit) return hit;
    const byTrigger = new Map<string, HydratedCommand>();
    for (const cmd of await this.commands.listCommands(serverId))
      byTrigger.set(cmd.trigger, cmd);
    const entry: RuntimeEntry = {
      at: Date.now(),
      prefix: await this.commands.getPrefix(serverId),
      byTrigger,
    };
    this.runtimeCache.set(serverId, entry);
    return entry;
  }

  private pruneCooldowns(): void {
    if (this.cooldowns.size >= 2000) {
      const cutoff = Date.now() - 86_400_000;
      for (const [k, ts] of this.cooldowns)
        if (ts < cutoff) this.cooldowns.delete(k);
    }
    if (this.triggerThrottle.size >= 2000) {
      const cutoff = Date.now() - 60_000;
      for (const [k, ts] of this.triggerThrottle)
        if (ts < cutoff) this.triggerThrottle.delete(k);
    }
  }

  /** Whisper to a player via RCON `tell`; never throws (fire-and-forget feedback). */
  private async whisper(
    serverId: string,
    player: string,
    message: unknown,
  ): Promise<void> {
    const text = asString(message)
      // eslint-disable-next-line no-control-regex -- intentionally strips control chars
      .replace(/[\r\n\x00-\x1f\x7f]/g, ' ')
      .trim()
      .slice(0, WHISPER_MAX);
    if (!text || !PLAYER_RE.test(player)) return;
    try {
      await this.containers.execCapture(serverId, [
        'rcon-cli',
        '--',
        'tell',
        player,
        text,
      ]);
    } catch {
      /* server just stopped / rcon busy — nothing to do */
    }
  }

  private isOp(serverId: string, player: string): boolean {
    const lower = player.toLowerCase();
    return this.roster
      .listPlayers(serverId)
      .some((e) => e.op && e.name.toLowerCase() === lower);
  }

  private isWhitelisted(serverId: string, player: string): boolean {
    const lower = player.toLowerCase();
    return this.roster
      .listPlayers(serverId)
      .some((e) => (e.whitelisted || e.op) && e.name.toLowerCase() === lower);
  }

  private hasPermission(
    serverId: string,
    player: string,
    permission: HydratedCommand['permission'],
  ): boolean {
    if (permission === 'ops') return this.isOp(serverId, player);
    if (permission === 'whitelist') return this.isWhitelisted(serverId, player);
    return true;
  }

  /** Fill {placeholder} tokens from a values map; unknown tokens are left as-is. */
  private renderTemplate(
    template: unknown,
    vars: Record<string, unknown>,
  ): string {
    return asString(template).replace(/\{(\w+)\}/g, (m: string, key: string) =>
      key in vars && vars[key] != null ? asString(vars[key]) : m,
    );
  }

  private prettyDim(d: string | null | undefined): string {
    return DIM_LABEL[d || ''] || (d ? this.pretty(d) : '');
  }

  /** Placeholder values available to a command's success message, from its result. */
  private resultVars(
    result: ActionResult = {},
  ): Record<string, string | number> {
    const v: Record<string, string | number> = {};
    for (const k of ['x', 'y', 'z', 'distance'] as const)
      if (result[k] != null) v[k] = result[k];
    if (result.dimension) v.dimension = this.prettyDim(result.dimension);
    if (result.structure) v.structure = this.pretty(result.structure);
    if (result.biome) v.biome = this.pretty(result.biome);
    return v;
  }

  private pretty(id: unknown): string {
    const base =
      asString(id)
        .replace(/^#/, '')
        .split(':')
        .pop()
        ?.split('/')
        .pop()
        ?.replace(/_/g, ' ') || '';
    return base.charAt(0).toUpperCase() + base.slice(1);
  }

  // -------------------------------------------------------------------------
  // Execution

  /**
   * Run one command's action as `player`. Returns the whisper/feedback message.
   * Teleport actions run inside the server-wide teleport slot; console commands
   * run sequentially over rcon with sanitized placeholder substitution.
   */
  private async executeAction(
    serverId: string,
    cmd: HydratedCommand,
    player: string,
    args: (string | undefined)[],
    ctx: RunOptions,
  ): Promise<ExecuteActionResult> {
    const p = cmd.params || {};
    if (cmd.action === 'rtp') {
      const result = await this.teleport.withTeleportSlot(serverId, () =>
        this.teleport.rtpPlayer(
          serverId,
          player,
          {
            minDistance: p.minDistance,
            maxDistance: p.maxDistance,
            center: p.center,
          },
          ctx,
        ),
      );
      return {
        message: `Whoosh! You landed ${result.distance} blocks away at ${result.x}, ${result.z} in ${this.prettyDim(result.dimension || '')}.`,
        result,
      };
    }
    if (cmd.action === 'structure') {
      const result = await this.teleport.withTeleportSlot(serverId, () =>
        this.teleport.tpToStructure(
          serverId,
          player,
          p.structure!,
          { random: p.random !== false, maxDistance: p.maxDistance },
          ctx,
        ),
      );
      return {
        message: `Teleported to a ${this.pretty(result.structure)} in ${this.prettyDim(result.dimension)} at ${result.x}, ${result.z}.`,
        result,
      };
    }
    if (cmd.action === 'biome') {
      const result = await this.teleport.withTeleportSlot(serverId, () =>
        this.teleport.tpToBiome(serverId, player, p.biome!, ctx),
      );
      return {
        message: `Teleported to ${this.pretty(result.biome)} in ${this.prettyDim(result.dimension)} at ${result.x}, ${result.z}.`,
        result,
      };
    }

    // console: placeholders substituted with sanitized values, run sequentially.
    const values: Record<string, string> = {
      player,
      arg1: this.sanitizeArg(args[0]),
      arg2: this.sanitizeArg(args[1]),
      arg3: this.sanitizeArg(args[2]),
    };
    let lastOut = '';
    for (const template of p.commands || []) {
      const line = template
        .replace(
          /\{(player|arg1|arg2|arg3)\}/g,
          (_, key: string) => values[key] ?? '',
        )
        .trim();
      if (!line) continue;
      const out = cleanText(
        await this.containers.execCapture(serverId, [
          'rcon-cli',
          '--',
          ...line.split(/\s+/),
        ]),
      );
      if (out.trim()) lastOut = out.trim();
    }
    return {
      message: lastOut || 'Done!',
      result: { commands: (p.commands || []).length, output: lastOut },
    };
  }

  private sanitizeArg(value: unknown): string {
    const v = asString(value).trim();
    return ARG_RE.test(v) ? v : '';
  }

  /**
   * Entry point for the log ingester. Fire-and-forget: every failure is handled
   * here (whisper + event) — nothing propagates back into log ingestion.
   */
  async handleChat(
    serverId: string,
    player: string,
    message: unknown,
  ): Promise<void> {
    const text = asString(message).trim();
    if (!text || !PLAYER_RE.test(String(player))) return;

    const runtime = await this.getRuntime(serverId);
    if (!runtime.byTrigger.size || !text.startsWith(runtime.prefix)) return;

    const parts = text.slice(runtime.prefix.length).trim().split(/\s+/);
    const trigger = (parts[0] || '').toLowerCase();
    if (!TRIGGER_RE.test(trigger)) return; // "!!!" and friends — normal chat
    const cmd = runtime.byTrigger.get(trigger);
    if (!cmd || !cmd.enabled) return; // unknown trigger — players chat with ! all the time
    const args = parts.slice(1, 4);
    const label = `${runtime.prefix}${trigger}`;

    // Cheap per-player spam guard BEFORE the permission lookup (which reads
    // ops.json/whitelist.json from disk): bounds how often a player can force those
    // sync reads by hammering a known trigger, protecting the event loop.
    const throttleKey = `${serverId}:${player.toLowerCase()}`;
    const lastSeen = this.triggerThrottle.get(throttleKey) || 0;
    if (Date.now() - lastSeen < ChatCommandsRuntimeService.THROTTLE_MS) return;
    this.triggerThrottle.set(throttleKey, Date.now());
    this.pruneCooldowns();

    // Permission
    if (!this.hasPermission(serverId, player, cmd.permission)) {
      void this.whisper(
        serverId,
        player,
        "You don't have permission to use that.",
      );
      this.events.recordEvent({
        serverId,
        actor: `chat:${player}`,
        type: 'chat-command',
        summary: `${player} tried ${label} — denied (needs ${cmd.permission})`,
        details: {
          trigger,
          action: cmd.action,
          player,
          success: false,
          reason: 'permission',
        },
      });
      return;
    }

    // Cooldown (per server + trigger + player)
    const cdKey = `${serverId}:${trigger}:${player.toLowerCase()}`;
    if (cmd.cooldownSec > 0) {
      const last = this.cooldowns.get(cdKey) || 0;
      const remainingMs = cmd.cooldownSec * 1000 - (Date.now() - last);
      if (remainingMs > 0) {
        void this.whisper(
          serverId,
          player,
          `Wait ${Math.ceil(remainingMs / 1000)}s before using ${label} again.`,
        );
        return;
      }
    }

    // One execution per player at a time (locate searches take seconds).
    const flightKey = `${serverId}:${player.toLowerCase()}`;
    if (this.inflight.has(flightKey)) {
      void this.whisper(
        serverId,
        player,
        'Your previous command is still running — give it a second.',
      );
      return;
    }
    this.inflight.add(flightKey);
    // Cooldown starts when the execution starts: retry-spamming an expensive
    // /locate search is exactly what cooldowns exist to prevent.
    this.cooldowns.set(cdKey, Date.now());
    this.pruneCooldowns();

    const ctx: RunOptions = { running: true, actor: `chat:${player}` };
    const baseVars = {
      player,
      trigger,
      arg1: this.sanitizeArg(args[0]),
      arg2: this.sanitizeArg(args[1]),
      arg3: this.sanitizeArg(args[2]),
    };
    // State 1 — pending: acknowledge immediately, before the (possibly slow) action.
    if (cmd.msgPending)
      void this.whisper(
        serverId,
        player,
        this.renderTemplate(cmd.msgPending, baseVars),
      );
    try {
      const { message: defaultMsg, result } = await this.executeAction(
        serverId,
        cmd,
        player,
        args,
        ctx,
      );
      await this.commands.bumpUsage(serverId, cmd);
      // State 2 — success: custom template (with result placeholders) or the built-in message.
      const successMsg = cmd.msgSuccess
        ? this.renderTemplate(cmd.msgSuccess, {
            ...baseVars,
            ...this.resultVars(result),
          })
        : defaultMsg;
      void this.whisper(serverId, player, successMsg);
      this.events.recordEvent({
        serverId,
        actor: `chat:${player}`,
        type: 'chat-command',
        summary: `${player} ran ${label} (${this.commands.actionSummary(cmd)})`,
        details: {
          trigger,
          action: cmd.action,
          params: cmd.params,
          player,
          args,
          success: true,
        },
      });
    } catch (err) {
      const e = err as Error & { status?: number };
      const friendly =
        e.status === 429
          ? 'The server is busy with another teleport — try again in a few seconds.'
          : e.message || 'That command failed — tell the server owner.';
      // State 3 — failure: custom template (with {error}) or the built-in message.
      const failMsg = cmd.msgFailure
        ? this.renderTemplate(cmd.msgFailure, {
            ...baseVars,
            error: e.message || 'error',
          })
        : friendly;
      void this.whisper(serverId, player, failMsg);
      this.events.recordEvent({
        serverId,
        actor: `chat:${player}`,
        type: 'chat-command',
        summary: `${player} ran ${label} — failed: ${String(e.message || e).slice(0, 140)}`,
        details: {
          trigger,
          action: cmd.action,
          player,
          args,
          success: false,
          reason: e.message,
        },
      });
    } finally {
      this.inflight.delete(flightKey);
    }
  }

  /**
   * Panel "Test" button: run a command NOW as a named player — same execution
   * path minus permission and cooldown checks. Throws on failure (the caller
   * turns it into a friendly JSON error); records an event either way.
   */
  async testCommand(
    serverId: string,
    cmdId: string,
    player: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<{ message: string; result: ActionResult }> {
    const cmd = await this.commands.getCommand(serverId, cmdId);
    if (!cmd) throw new NotFoundException('Chat command not found');
    if (!PLAYER_RE.test(String(player)))
      throw new BadRequestException('Invalid player name');

    const flightKey = `${serverId}:${String(player).toLowerCase()}`;
    if (this.inflight.has(flightKey))
      throw new HttpException(
        'That player already has a command running — wait a moment.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    this.inflight.add(flightKey);
    const ctx: RunOptions = { running: true, actor };
    const baseVars = {
      player,
      trigger: cmd.trigger,
      arg1: '',
      arg2: '',
      arg3: '',
    };
    if (cmd.msgPending)
      void this.whisper(
        serverId,
        player,
        this.renderTemplate(cmd.msgPending, baseVars),
      );
    try {
      const { message: defaultMsg, result } = await this.executeAction(
        serverId,
        cmd,
        player,
        [],
        ctx,
      );
      await this.commands.bumpUsage(serverId, cmd);
      const message = cmd.msgSuccess
        ? this.renderTemplate(cmd.msgSuccess, {
            ...baseVars,
            ...this.resultVars(result),
          })
        : defaultMsg;
      void this.whisper(serverId, player, message);
      this.events.recordEvent({
        serverId,
        actor,
        type: 'chat-command',
        summary: `${player} ran ${await this.commands.getPrefix(serverId)}${cmd.trigger} (${this.commands.actionSummary(cmd)}) — panel test`,
        details: {
          trigger: cmd.trigger,
          action: cmd.action,
          params: cmd.params,
          player,
          success: true,
          via: 'test',
        },
      });
      return { message, result };
    } catch (err) {
      const e = err as Error;
      if (cmd.msgFailure)
        void this.whisper(
          serverId,
          player,
          this.renderTemplate(cmd.msgFailure, {
            ...baseVars,
            error: e.message || 'error',
          }),
        );
      this.events.recordEvent({
        serverId,
        actor,
        type: 'chat-command',
        summary: `Panel test of ${await this.commands.getPrefix(serverId)}${cmd.trigger} as ${player} failed: ${String(e.message || e).slice(0, 140)}`,
        details: {
          trigger: cmd.trigger,
          action: cmd.action,
          player,
          success: false,
          reason: e.message,
          via: 'test',
        },
      });
      throw err;
    } finally {
      this.inflight.delete(flightKey);
    }
  }
}
