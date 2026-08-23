import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { DbService } from '../db/db.service';
import { chatCommandSettings, chatCommands } from '../db/schema';
import { EventsService } from '../events/events.service';
import { ContainerService } from '../docker/container.service';
import { PlayerRosterService } from '../players/player-roster.service';
import { PlayerTeleportService } from '../players/player-teleport.service';
import { cleanText } from '../utils/ansi';
import { PLAYER_NAME_RE } from '../utils/player-name';
import type {
  ActionParams,
  ActionResult,
  ChatAction,
  ChatPermission,
  CommandChanges,
  CommandSpec,
  ExecuteActionResult,
  HydratedCommand,
  RunOptions,
  ValidateSpecInput,
} from './chat.types';

type ChatCommandRow = typeof chatCommands.$inferSelect;

const TRIGGER_RE = /^[a-z0-9_-]{1,24}$/i;
// 1-2 chars from a safe set. '/' is deliberately absent — real commands never
// reach the chat log, so a '/' prefix could never fire.
const PREFIX_RE = /^[!.#+?$%&*~^=-]{1,2}$/;
const PLAYER_RE = PLAYER_NAME_RE;
// Chat args substituted into console commands: strict shape or dropped.
const ARG_RE = /^[A-Za-z0-9_:\-.]{0,32}$/;
const ACTIONS = new Set(['rtp', 'structure', 'biome', 'console']);
const PERMISSIONS = new Set(['everyone', 'whitelist', 'ops']);
// Console commands that can wreck a server — ops-only triggers may use them.
// Flagged when the command IS one of these (start of string) OR is an `execute`
// chain that ends in `run <dangerous>` — `execute as @a at @s run stop` reaches
// the same effect via command nesting and must not slip past a non-ops trigger.
// The nesting branch is gated on a leading `execute` on purpose: `run` is only a
// command-nesting keyword inside `execute`, so a plain `say we run stop now` is
// arbitrary chat text, not a nested command, and must NOT be blocked.
const DANGER = String.raw`stop\b|op\s|deop\b|ban\b|ban-ip\b|pardon\b|pardon-ip\b|whitelist\b`;
export const DANGEROUS_RE = new RegExp(String.raw`^\s*\/?\s*(?:(?:${DANGER})|execute\b.*\srun\s+\/?\s*(?:${DANGER}))`, 'i');
const WHISPER_MAX = 120;
const CACHE_MS = 60_000;

const DIM_LABEL: Record<string, string> = {
  'minecraft:overworld': 'the Overworld',
  'minecraft:the_nether': 'the Nether',
  'minecraft:the_end': 'the End',
};

interface RuntimeEntry {
  at: number;
  prefix: string;
  byTrigger: Map<string, HydratedCommand>;
}

/**
 * Custom chat commands: the owner registers triggers like `rtp2` per server;
 * when a player types `!rtp2` in game chat the log ingester calls handleChat()
 * and the bound action (panel RTP / structure tp / biome tp / raw console
 * commands) runs AS that player, with per-command permissions and cooldowns.
 * Zero mods — detection is log-based, execution is RCON-based.
 *
 * Ports `src/services/chatCommands.ts` as one service — CRUD, prefix
 * management, and runtime execution share the same in-memory cache/cooldown/
 * inflight maps tightly enough (CRUD invalidates the cache the runtime path
 * reads) that splitting further would be artificial, matching the reasoning
 * already used for `SchedulerService`.
 *
 * `isOp`/`isWhitelisted` reuse `PlayerRosterService.listPlayers()` (which
 * already aggregates ops.json/whitelist.json/banned-players.json/
 * usercache.json into one roster) rather than reaching into its private
 * per-file readJson — a few extra file reads per permission check, traded
 * for not exposing file-format internals across the module boundary.
 */
@Injectable()
export class ChatCommandsService {
  private readonly cache = new Map<string, RuntimeEntry>();
  private readonly cooldowns = new Map<string, number>(); // `${serverId}:${trigger}:${playerLower}` -> last run ts
  private readonly inflight = new Set<string>(); // `${serverId}:${playerLower}` — one execution per player
  private readonly triggerThrottle = new Map<string, number>(); // `${serverId}:${playerLower}` -> last-processed ts (spam guard)
  private static readonly THROTTLE_MS = 400;

  constructor(
    private readonly dbService: DbService,
    private readonly events: EventsService,
    private readonly containers: ContainerService,
    private readonly roster: PlayerRosterService,
    private readonly teleport: PlayerTeleportService
  ) {}

  private get db() {
    return this.dbService.db;
  }

  // -------------------------------------------------------------------------
  // Validation (routes' zod-validate shapes should mirror this; this is the
  // single source of truth for semantics so direct service callers get the
  // same guarantees)

  private validateSpec({
    trigger: rawTrigger,
    description,
    action,
    params,
    permission,
    cooldownSec,
    msgPending,
    msgSuccess,
    msgFailure,
  }: ValidateSpecInput): CommandSpec {
    const trigger = String(rawTrigger || '')
      .trim()
      .toLowerCase();
    if (!TRIGGER_RE.test(trigger)) {
      throw new BadRequestException('Triggers are 1-24 letters, digits, - or _ (no spaces, no prefix)');
    }
    if (!ACTIONS.has(action)) throw new BadRequestException('Unknown action');
    if (!PERMISSIONS.has(permission)) throw new BadRequestException('Unknown permission level');
    const cooldown = Math.floor(Number(cooldownSec));
    if (!Number.isFinite(cooldown) || cooldown < 0 || cooldown > 86400) {
      throw new BadRequestException('Cooldown must be 0-86400 seconds');
    }

    const p: ActionParams = params && typeof params === 'object' ? params : {};
    let clean: ActionParams;
    if (action === 'rtp') {
      const minDistance = Math.max(0, Math.floor(Number(p.minDistance ?? 500) || 0));
      const maxDistance = Math.max(16, Math.floor(Number(p.maxDistance ?? 5000) || 5000));
      if (maxDistance <= minDistance) throw new BadRequestException('Max distance must be greater than min distance');
      if (maxDistance > 1_000_000) throw new BadRequestException('Max distance is capped at 1,000,000');
      clean = { minDistance, maxDistance, center: p.center === 'origin' ? 'origin' : 'player' };
    } else if (action === 'structure') {
      if (!/^#?[a-z0-9_.-]+:[a-z0-9_/.-]+$/.test(String(p.structure || ''))) {
        throw new BadRequestException('Pick a valid structure');
      }
      const maxDistance = Math.min(1_000_000, Math.max(16, Math.floor(Number(p.maxDistance ?? 5000) || 5000)));
      clean = { structure: String(p.structure), random: p.random !== false, maxDistance };
    } else if (action === 'biome') {
      if (!/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/.test(String(p.biome || ''))) {
        throw new BadRequestException('Pick a valid biome');
      }
      clean = { biome: String(p.biome) };
    } else {
      const commands = Array.isArray(p.commands)
        ? p.commands
            .map((c) =>
              String(c)
                .replace(/[\r\x00-\x1f\x7f]/g, ' ')
                .trim()
            )
            .filter(Boolean)
        : [];
      if (!commands.length) throw new BadRequestException('Add at least one console command');
      if (commands.length > 10) throw new BadRequestException('Max 10 console commands per trigger');
      for (const cmd of commands) {
        if (cmd.length > 200) throw new BadRequestException('Console commands are capped at 200 characters each');
        if (permission !== 'ops' && DANGEROUS_RE.test(cmd)) {
          throw new BadRequestException(`"${cmd.split(/\s+/)[0]}" commands are only allowed when permission is set to Ops`);
        }
      }
      clean = { commands: commands.map((c) => c.replace(/^\//, '')) };
    }

    return {
      trigger,
      description: String(description || '')
        .trim()
        .slice(0, 200),
      action,
      params: clean,
      permission,
      cooldownSec: cooldown,
      msgPending: this.cleanMessage(msgPending),
      msgSuccess: this.cleanMessage(msgSuccess),
      msgFailure: this.cleanMessage(msgFailure),
    };
  }

  // Feedback templates: strip control chars, cap length, empty -> null (use default).
  private cleanMessage(v: unknown): string | null {
    const s = String(v ?? '')
      .replace(/[\r\n\x00-\x1f\x7f]/g, ' ')
      .trim()
      .slice(0, 200);
    return s || null;
  }

  /** Fill {placeholder} tokens from a values map; unknown tokens are left as-is. */
  private renderTemplate(template: unknown, vars: Record<string, unknown>): string {
    return String(template).replace(/\{(\w+)\}/g, (m, key) => (key in vars && vars[key] != null ? String(vars[key]) : m));
  }

  private prettyDim(d: string | null | undefined): string {
    return DIM_LABEL[d || ''] || (d ? this.pretty(d) : '');
  }

  /** Placeholder values available to a command's success message, from its result. */
  private resultVars(result: ActionResult = {}): Record<string, string | number> {
    const v: Record<string, string | number> = {};
    for (const k of ['x', 'y', 'z', 'distance'] as const) if (result[k] != null) v[k] = result[k];
    if (result.dimension) v.dimension = this.prettyDim(result.dimension);
    if (result.structure) v.structure = this.pretty(result.structure);
    if (result.biome) v.biome = this.pretty(result.biome);
    return v;
  }

  // -------------------------------------------------------------------------
  // CRUD + prefix

  private hydrate(row: ChatCommandRow): HydratedCommand {
    let params: ActionParams = {};
    try {
      params = JSON.parse(row.params || '{}');
    } catch {
      /* corrupt row — empty params */
    }
    return { ...row, action: row.action as ChatAction, permission: row.permission as ChatPermission, params, enabled: Boolean(row.enabled) };
  }

  listCommands(serverId: string): HydratedCommand[] {
    return this.db
      .select()
      .from(chatCommands)
      .where(eq(chatCommands.serverId, serverId))
      .orderBy(asc(chatCommands.trigger))
      .all()
      .map((row) => this.hydrate(row));
  }

  getCommand(serverId: string, cmdId: string): HydratedCommand | null {
    const row = this.db
      .select()
      .from(chatCommands)
      .where(sql`${chatCommands.id} = ${cmdId} AND ${chatCommands.serverId} = ${serverId}`)
      .get();
    return row ? this.hydrate(row) : null;
  }

  getPrefix(serverId: string): string {
    const row = this.db.select({ prefix: chatCommandSettings.prefix }).from(chatCommandSettings).where(eq(chatCommandSettings.serverId, serverId)).get();
    return row ? row.prefix : '!';
  }

  setPrefix(serverId: string, prefixInput: unknown, { actor = 'system' }: { actor?: string } = {}): { prefix: string } {
    const prefix = String(prefixInput || '').trim();
    if (!PREFIX_RE.test(prefix)) {
      throw new BadRequestException('Prefix must be 1-2 characters from ! . # + ? $ % & * ~ ^ = - (never /)');
    }
    this.db
      .insert(chatCommandSettings)
      .values({ serverId, prefix })
      .onConflictDoUpdate({ target: chatCommandSettings.serverId, set: { prefix } })
      .run();
    this.cache.delete(serverId);
    this.events.recordEvent({
      serverId,
      actor,
      type: 'chat-command-config',
      summary: `Chat command prefix set to "${prefix}"`,
      details: { prefix },
    });
    return { prefix };
  }

  createCommand(serverId: string, input: ValidateSpecInput & { enabled?: boolean }, { actor = 'system' }: { actor?: string } = {}): HydratedCommand | null {
    const spec = this.validateSpec(input);
    const enabled = input.enabled !== false;
    const id = `ccmd_${nanoid(8)}`;
    try {
      this.db
        .insert(chatCommands)
        .values({
          id,
          serverId,
          trigger: spec.trigger,
          description: spec.description,
          action: spec.action,
          params: JSON.stringify(spec.params),
          permission: spec.permission,
          cooldownSec: spec.cooldownSec,
          enabled,
          msgPending: spec.msgPending,
          msgSuccess: spec.msgSuccess,
          msgFailure: spec.msgFailure,
        })
        .run();
    } catch (err) {
      if (/UNIQUE/i.test((err as Error).message)) {
        throw new ConflictException(`A command named "${spec.trigger}" already exists on this server`);
      }
      throw err;
    }
    this.cache.delete(serverId);
    this.events.recordEvent({
      serverId,
      actor,
      type: 'chat-command-config',
      summary: `Chat command ${this.getPrefix(serverId)}${spec.trigger} created (${this.actionSummary(spec)})`,
      details: { id, ...spec },
    });
    return this.getCommand(serverId, id);
  }

  updateCommand(serverId: string, cmdId: string, changes: CommandChanges, { actor = 'system' }: { actor?: string } = {}): HydratedCommand | null {
    const existing = this.getCommand(serverId, cmdId);
    if (!existing) throw new NotFoundException('Chat command not found');

    // Enabled-only toggles skip full re-validation (fast path for the UI toggle).
    const keys = (Object.keys(changes) as (keyof CommandChanges)[]).filter((k) => changes[k] !== undefined);
    if (keys.length === 1 && keys[0] === 'enabled') {
      this.db.update(chatCommands).set({ enabled: Boolean(changes.enabled) }).where(eq(chatCommands.id, cmdId)).run();
      this.cache.delete(serverId);
      this.events.recordEvent({
        serverId,
        actor,
        type: 'chat-command-config',
        summary: `Chat command ${this.getPrefix(serverId)}${existing.trigger} ${changes.enabled ? 'enabled' : 'disabled'}`,
        details: { id: cmdId, enabled: Boolean(changes.enabled) },
      });
      return this.getCommand(serverId, cmdId);
    }

    const spec = this.validateSpec({
      trigger: changes.trigger ?? existing.trigger,
      description: changes.description ?? existing.description,
      action: changes.action ?? existing.action,
      params: changes.params ?? existing.params,
      permission: changes.permission ?? existing.permission,
      cooldownSec: changes.cooldownSec ?? existing.cooldownSec,
      msgPending: changes.msgPending ?? existing.msgPending,
      msgSuccess: changes.msgSuccess ?? existing.msgSuccess,
      msgFailure: changes.msgFailure ?? existing.msgFailure,
    });
    const enabled = changes.enabled ?? existing.enabled;
    try {
      this.db
        .update(chatCommands)
        .set({
          trigger: spec.trigger,
          description: spec.description,
          action: spec.action,
          params: JSON.stringify(spec.params),
          permission: spec.permission,
          cooldownSec: spec.cooldownSec,
          enabled,
          msgPending: spec.msgPending,
          msgSuccess: spec.msgSuccess,
          msgFailure: spec.msgFailure,
        })
        .where(eq(chatCommands.id, cmdId))
        .run();
    } catch (err) {
      if (/UNIQUE/i.test((err as Error).message)) {
        throw new ConflictException(`A command named "${spec.trigger}" already exists on this server`);
      }
      throw err;
    }
    this.cache.delete(serverId);
    this.events.recordEvent({
      serverId,
      actor,
      type: 'chat-command-config',
      summary: `Chat command ${this.getPrefix(serverId)}${spec.trigger} updated (${this.actionSummary(spec)})`,
      details: { id: cmdId, ...spec, enabled },
    });
    return this.getCommand(serverId, cmdId);
  }

  deleteCommand(serverId: string, cmdId: string, { actor = 'system' }: { actor?: string } = {}): { deleted: true } {
    const existing = this.getCommand(serverId, cmdId);
    if (!existing) throw new NotFoundException('Chat command not found');
    this.db.delete(chatCommands).where(eq(chatCommands.id, cmdId)).run();
    this.cache.delete(serverId);
    this.events.recordEvent({
      serverId,
      actor,
      type: 'chat-command-config',
      summary: `Chat command ${this.getPrefix(serverId)}${existing.trigger} deleted`,
      details: { id: cmdId, trigger: existing.trigger },
    });
    return { deleted: true };
  }

  /** "rtp 500-5000" / "structure #minecraft:village" / "console ×2" — for events + UI. */
  actionSummary(cmd: { action: ChatAction; params: ActionParams }): string {
    const p = cmd.params || {};
    if (cmd.action === 'rtp') return `rtp ${p.minDistance ?? 500}-${p.maxDistance ?? 5000}${p.center === 'origin' ? ' around 0,0' : ''}`;
    if (cmd.action === 'structure') return `structure ${String(p.structure || '').replace(/^#/, '')}${p.random === false ? ' (nearest)' : ''}`;
    if (cmd.action === 'biome') return `biome ${p.biome || ''}`;
    return `console ×${Array.isArray(p.commands) ? p.commands.length : 0}`;
  }

  // -------------------------------------------------------------------------
  // Runtime: cache, cooldowns, concurrency

  private getRuntime(serverId: string): RuntimeEntry {
    const hit = this.cache.get(serverId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit;
    const byTrigger = new Map<string, HydratedCommand>();
    for (const cmd of this.listCommands(serverId)) byTrigger.set(cmd.trigger, cmd);
    const entry: RuntimeEntry = { at: Date.now(), prefix: this.getPrefix(serverId), byTrigger };
    this.cache.set(serverId, entry);
    return entry;
  }

  private pruneCooldowns(): void {
    if (this.cooldowns.size >= 2000) {
      const cutoff = Date.now() - 86_400_000;
      for (const [k, ts] of this.cooldowns) if (ts < cutoff) this.cooldowns.delete(k);
    }
    if (this.triggerThrottle.size >= 2000) {
      const cutoff = Date.now() - 60_000;
      for (const [k, ts] of this.triggerThrottle) if (ts < cutoff) this.triggerThrottle.delete(k);
    }
  }

  /** Whisper to a player via RCON `tell`; never throws (fire-and-forget feedback). */
  private async whisper(serverId: string, player: string, message: unknown): Promise<void> {
    const text = String(message || '')
      .replace(/[\r\n\x00-\x1f\x7f]/g, ' ')
      .trim()
      .slice(0, WHISPER_MAX);
    if (!text || !PLAYER_RE.test(player)) return;
    try {
      await this.containers.execCapture(serverId, ['rcon-cli', '--', 'tell', player, text]);
    } catch {
      /* server just stopped / rcon busy — nothing to do */
    }
  }

  private isOp(serverId: string, player: string): boolean {
    const lower = player.toLowerCase();
    return this.roster.listPlayers(serverId).some((e) => e.op && e.name.toLowerCase() === lower);
  }

  private isWhitelisted(serverId: string, player: string): boolean {
    const lower = player.toLowerCase();
    return this.roster.listPlayers(serverId).some((e) => (e.whitelisted || e.op) && e.name.toLowerCase() === lower);
  }

  private hasPermission(serverId: string, player: string, permission: ChatPermission): boolean {
    if (permission === 'ops') return this.isOp(serverId, player);
    if (permission === 'whitelist') return this.isWhitelisted(serverId, player);
    return true;
  }

  // -------------------------------------------------------------------------
  // Execution

  /**
   * Run one command's action as `player`. Returns the whisper/feedback message.
   * Teleport actions run inside the server-wide teleport slot; console commands
   * run sequentially over rcon with sanitized placeholder substitution.
   */
  private async executeAction(serverId: string, cmd: HydratedCommand, player: string, args: (string | undefined)[], ctx: RunOptions): Promise<ExecuteActionResult> {
    const p = cmd.params || {};
    if (cmd.action === 'rtp') {
      const result = await this.teleport.withTeleportSlot(serverId, () => this.teleport.rtpPlayer(serverId, player, { minDistance: p.minDistance, maxDistance: p.maxDistance, center: p.center }, ctx));
      return {
        message: `Whoosh! You landed ${result.distance} blocks away at ${result.x}, ${result.z} in ${this.prettyDim(result.dimension || '')}.`,
        result,
      };
    }
    if (cmd.action === 'structure') {
      const result = await this.teleport.withTeleportSlot(serverId, () => this.teleport.tpToStructure(serverId, player, p.structure!, { random: p.random !== false, maxDistance: p.maxDistance }, ctx));
      return {
        message: `Teleported to a ${this.pretty(result.structure)} in ${this.prettyDim(result.dimension)} at ${result.x}, ${result.z}.`,
        result,
      };
    }
    if (cmd.action === 'biome') {
      const result = await this.teleport.withTeleportSlot(serverId, () => this.teleport.tpToBiome(serverId, player, p.biome!, ctx));
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
      const line = template.replace(/\{(player|arg1|arg2|arg3)\}/g, (_, key: string) => values[key] ?? '').trim();
      if (!line) continue;
      const out = cleanText(await this.containers.execCapture(serverId, ['rcon-cli', '--', ...line.split(/\s+/)]));
      if (out.trim()) lastOut = out.trim();
    }
    return { message: lastOut || 'Done!', result: { commands: (p.commands || []).length, output: lastOut } };
  }

  private sanitizeArg(value: unknown): string {
    const v = String(value ?? '').trim();
    return ARG_RE.test(v) ? v : '';
  }

  private pretty(id: unknown): string {
    const base =
      String(id || '')
        .replace(/^#/, '')
        .split(':')
        .pop()
        ?.split('/')
        .pop()
        ?.replace(/_/g, ' ') || '';
    return base.charAt(0).toUpperCase() + base.slice(1);
  }

  private bumpUsage(serverId: string, cmd: HydratedCommand): void {
    this.db
      .update(chatCommands)
      .set({ uses: sql`${chatCommands.uses} + 1`, lastUsedAt: sql`(datetime('now'))` })
      .where(eq(chatCommands.id, cmd.id))
      .run();
    this.cache.delete(serverId);
  }

  /**
   * Entry point for the log ingester. Fire-and-forget: every failure is handled
   * here (whisper + event) — nothing propagates back into log ingestion.
   */
  async handleChat(serverId: string, player: string, message: unknown): Promise<void> {
    const text = String(message || '').trim();
    if (!text || !PLAYER_RE.test(String(player))) return;

    const runtime = this.getRuntime(serverId);
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
    if (Date.now() - lastSeen < ChatCommandsService.THROTTLE_MS) return;
    this.triggerThrottle.set(throttleKey, Date.now());
    this.pruneCooldowns();

    // Permission
    if (!this.hasPermission(serverId, player, cmd.permission)) {
      void this.whisper(serverId, player, "You don't have permission to use that.");
      this.events.recordEvent({
        serverId,
        actor: `chat:${player}`,
        type: 'chat-command',
        summary: `${player} tried ${label} — denied (needs ${cmd.permission})`,
        details: { trigger, action: cmd.action, player, success: false, reason: 'permission' },
      });
      return;
    }

    // Cooldown (per server + trigger + player)
    const cdKey = `${serverId}:${trigger}:${player.toLowerCase()}`;
    if (cmd.cooldownSec > 0) {
      const last = this.cooldowns.get(cdKey) || 0;
      const remainingMs = cmd.cooldownSec * 1000 - (Date.now() - last);
      if (remainingMs > 0) {
        void this.whisper(serverId, player, `Wait ${Math.ceil(remainingMs / 1000)}s before using ${label} again.`);
        return;
      }
    }

    // One execution per player at a time (locate searches take seconds).
    const flightKey = `${serverId}:${player.toLowerCase()}`;
    if (this.inflight.has(flightKey)) {
      void this.whisper(serverId, player, 'Your previous command is still running — give it a second.');
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
    if (cmd.msgPending) void this.whisper(serverId, player, this.renderTemplate(cmd.msgPending, baseVars));
    try {
      const { message: defaultMsg, result } = await this.executeAction(serverId, cmd, player, args, ctx);
      this.bumpUsage(serverId, cmd);
      // State 2 — success: custom template (with result placeholders) or the built-in message.
      const successMsg = cmd.msgSuccess ? this.renderTemplate(cmd.msgSuccess, { ...baseVars, ...this.resultVars(result) }) : defaultMsg;
      void this.whisper(serverId, player, successMsg);
      this.events.recordEvent({
        serverId,
        actor: `chat:${player}`,
        type: 'chat-command',
        summary: `${player} ran ${label} (${this.actionSummary(cmd)})`,
        details: { trigger, action: cmd.action, params: cmd.params, player, args, success: true },
      });
    } catch (err) {
      const e = err as Error & { status?: number };
      const friendly = e.status === 429 ? 'The server is busy with another teleport — try again in a few seconds.' : e.message || 'That command failed — tell the server owner.';
      // State 3 — failure: custom template (with {error}) or the built-in message.
      const failMsg = cmd.msgFailure ? this.renderTemplate(cmd.msgFailure, { ...baseVars, error: e.message || 'error' }) : friendly;
      void this.whisper(serverId, player, failMsg);
      this.events.recordEvent({
        serverId,
        actor: `chat:${player}`,
        type: 'chat-command',
        summary: `${player} ran ${label} — failed: ${String(e.message || e).slice(0, 140)}`,
        details: { trigger, action: cmd.action, player, args, success: false, reason: e.message },
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
  async testCommand(serverId: string, cmdId: string, player: string, { actor = 'system' }: { actor?: string } = {}): Promise<{ message: string; result: ActionResult }> {
    const cmd = this.getCommand(serverId, cmdId);
    if (!cmd) throw new NotFoundException('Chat command not found');
    if (!PLAYER_RE.test(String(player))) throw new BadRequestException('Invalid player name');

    const flightKey = `${serverId}:${String(player).toLowerCase()}`;
    if (this.inflight.has(flightKey)) throw new HttpException('That player already has a command running — wait a moment.', HttpStatus.TOO_MANY_REQUESTS);
    this.inflight.add(flightKey);
    const ctx: RunOptions = { running: true, actor };
    const baseVars = { player, trigger: cmd.trigger, arg1: '', arg2: '', arg3: '' };
    if (cmd.msgPending) void this.whisper(serverId, player, this.renderTemplate(cmd.msgPending, baseVars));
    try {
      const { message: defaultMsg, result } = await this.executeAction(serverId, cmd, player, [], ctx);
      this.bumpUsage(serverId, cmd);
      const message = cmd.msgSuccess ? this.renderTemplate(cmd.msgSuccess, { ...baseVars, ...this.resultVars(result) }) : defaultMsg;
      void this.whisper(serverId, player, message);
      this.events.recordEvent({
        serverId,
        actor,
        type: 'chat-command',
        summary: `${player} ran ${this.getPrefix(serverId)}${cmd.trigger} (${this.actionSummary(cmd)}) — panel test`,
        details: { trigger: cmd.trigger, action: cmd.action, params: cmd.params, player, success: true, via: 'test' },
      });
      return { message, result };
    } catch (err) {
      const e = err as Error;
      if (cmd.msgFailure) void this.whisper(serverId, player, this.renderTemplate(cmd.msgFailure, { ...baseVars, error: e.message || 'error' }));
      this.events.recordEvent({
        serverId,
        actor,
        type: 'chat-command',
        summary: `Panel test of ${this.getPrefix(serverId)}${cmd.trigger} as ${player} failed: ${String(e.message || e).slice(0, 140)}`,
        details: { trigger: cmd.trigger, action: cmd.action, player, success: false, reason: e.message, via: 'test' },
      });
      throw err;
    } finally {
      this.inflight.delete(flightKey);
    }
  }

  readonly TRIGGER_RE = TRIGGER_RE;
  readonly PREFIX_RE = PREFIX_RE;
  readonly DANGEROUS_RE = DANGEROUS_RE;
}
