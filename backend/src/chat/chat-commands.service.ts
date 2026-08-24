import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { DbService } from '../db/db.service';
import { chatCommandSettings, chatCommands } from '../db/schema';
import { EventsService } from '../events/events.service';
import { ChatCommandsCacheService } from './chat-commands-cache.service';
import type {
  ActionParams,
  ChatAction,
  ChatPermission,
  CommandChanges,
  CommandSpec,
  HydratedCommand,
  ValidateSpecInput,
} from './chat.types';

type ChatCommandRow = typeof chatCommands.$inferSelect;

export const TRIGGER_RE = /^[a-z0-9_-]{1,24}$/i;
// 1-2 chars from a safe set. '/' is deliberately absent — real commands never
// reach the chat log, so a '/' prefix could never fire.
export const PREFIX_RE = /^[!.#+?$%&*~^=-]{1,2}$/;
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
export const DANGEROUS_RE = new RegExp(
  String.raw`^\s*\/?\s*(?:(?:${DANGER})|execute\b.*\srun\s+\/?\s*(?:${DANGER}))`,
  'i',
);

/** Coerce an unknown (e.g. request-body) value to a display/comparison string. */
export function asString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

/**
 * Custom chat commands: persistence/CRUD side. The owner registers/edits
 * triggers like `rtp2` per server through this service; `ChatCommandsRuntimeService`
 * is the other half — it dispatches `!rtp2`-style chat messages against
 * whatever this service last wrote, via the shared `ChatCommandsCacheService`.
 *
 * Ports `src/services/chatCommands.ts`'s CRUD + prefix + spec-validation
 * section. This used to live on one class together with the runtime dispatch
 * engine (cache/cooldown/inflight maps, RCON execution) because both sides
 * shared the same in-memory cache tightly enough (CRUD invalidates the cache
 * the runtime path reads) that splitting felt artificial. That cache is now
 * `ChatCommandsCacheService`, a small collaborator both sides depend on
 * instead of depending on each other — so persistence and runtime can now be
 * reasoned about (and tested) independently, while every write here still
 * invalidates the cache the runtime path reads, exactly as before.
 */
@Injectable()
export class ChatCommandsService {
  constructor(
    private readonly dbService: DbService,
    private readonly events: EventsService,
    private readonly cache: ChatCommandsCacheService,
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
    const trigger = asString(rawTrigger).trim().toLowerCase();
    if (!TRIGGER_RE.test(trigger)) {
      throw new BadRequestException(
        'Triggers are 1-24 letters, digits, - or _ (no spaces, no prefix)',
      );
    }
    if (!ACTIONS.has(action)) throw new BadRequestException('Unknown action');
    if (!PERMISSIONS.has(permission))
      throw new BadRequestException('Unknown permission level');
    const cooldown = Math.floor(Number(cooldownSec));
    if (!Number.isFinite(cooldown) || cooldown < 0 || cooldown > 86400) {
      throw new BadRequestException('Cooldown must be 0-86400 seconds');
    }

    const p: ActionParams = params && typeof params === 'object' ? params : {};
    let clean: ActionParams;
    if (action === 'rtp') {
      const minDistance = Math.max(
        0,
        Math.floor(Number(p.minDistance ?? 500) || 0),
      );
      const maxDistance = Math.max(
        16,
        Math.floor(Number(p.maxDistance ?? 5000) || 5000),
      );
      if (maxDistance <= minDistance)
        throw new BadRequestException(
          'Max distance must be greater than min distance',
        );
      if (maxDistance > 1_000_000)
        throw new BadRequestException('Max distance is capped at 1,000,000');
      clean = {
        minDistance,
        maxDistance,
        center: p.center === 'origin' ? 'origin' : 'player',
      };
    } else if (action === 'structure') {
      if (!/^#?[a-z0-9_.-]+:[a-z0-9_/.-]+$/.test(String(p.structure || ''))) {
        throw new BadRequestException('Pick a valid structure');
      }
      const maxDistance = Math.min(
        1_000_000,
        Math.max(16, Math.floor(Number(p.maxDistance ?? 5000) || 5000)),
      );
      clean = {
        structure: String(p.structure),
        random: p.random !== false,
        maxDistance,
      };
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
                // eslint-disable-next-line no-control-regex -- intentionally strips control chars
                .replace(/[\r\x00-\x1f\x7f]/g, ' ')
                .trim(),
            )
            .filter(Boolean)
        : [];
      if (!commands.length)
        throw new BadRequestException('Add at least one console command');
      if (commands.length > 10)
        throw new BadRequestException('Max 10 console commands per trigger');
      for (const cmd of commands) {
        if (cmd.length > 200)
          throw new BadRequestException(
            'Console commands are capped at 200 characters each',
          );
        if (permission !== 'ops' && DANGEROUS_RE.test(cmd)) {
          throw new BadRequestException(
            `"${cmd.split(/\s+/)[0]}" commands are only allowed when permission is set to Ops`,
          );
        }
      }
      clean = { commands: commands.map((c) => c.replace(/^\//, '')) };
    }

    return {
      trigger,
      description: asString(description).trim().slice(0, 200),
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
    const s = asString(v)
      // eslint-disable-next-line no-control-regex -- intentionally strips control chars
      .replace(/[\r\n\x00-\x1f\x7f]/g, ' ')
      .trim()
      .slice(0, 200);
    return s || null;
  }

  // -------------------------------------------------------------------------
  // CRUD + prefix

  private hydrate(row: ChatCommandRow): HydratedCommand {
    let params: ActionParams = {};
    try {
      params = JSON.parse(row.params || '{}') as ActionParams;
    } catch {
      /* corrupt row — empty params */
    }
    return {
      ...row,
      action: row.action as ChatAction,
      permission: row.permission as ChatPermission,
      params,
      enabled: Boolean(row.enabled),
    };
  }

  async listCommands(serverId: string): Promise<HydratedCommand[]> {
    const rows = await this.db
      .select()
      .from(chatCommands)
      .where(eq(chatCommands.serverId, serverId))
      .orderBy(asc(chatCommands.trigger));
    return rows.map((row) => this.hydrate(row));
  }

  async getCommand(
    serverId: string,
    cmdId: string,
  ): Promise<HydratedCommand | null> {
    const [row] = await this.db
      .select()
      .from(chatCommands)
      .where(
        sql`${chatCommands.id} = ${cmdId} AND ${chatCommands.serverId} = ${serverId}`,
      )
      .limit(1);
    return row ? this.hydrate(row) : null;
  }

  async getPrefix(serverId: string): Promise<string> {
    const [row] = await this.db
      .select({ prefix: chatCommandSettings.prefix })
      .from(chatCommandSettings)
      .where(eq(chatCommandSettings.serverId, serverId))
      .limit(1);
    return row ? row.prefix : '!';
  }

  async setPrefix(
    serverId: string,
    prefixInput: unknown,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<{ prefix: string }> {
    const prefix = asString(prefixInput).trim();
    if (!PREFIX_RE.test(prefix)) {
      throw new BadRequestException(
        'Prefix must be 1-2 characters from ! . # + ? $ % & * ~ ^ = - (never /)',
      );
    }
    await this.db
      .insert(chatCommandSettings)
      .values({ serverId, prefix })
      .onConflictDoUpdate({
        target: chatCommandSettings.serverId,
        set: { prefix },
      });
    this.cache.invalidate(serverId);
    this.events.recordEvent({
      serverId,
      actor,
      type: 'chat-command-config',
      summary: `Chat command prefix set to "${prefix}"`,
      details: { prefix },
    });
    return { prefix };
  }

  async createCommand(
    serverId: string,
    input: ValidateSpecInput & { enabled?: boolean },
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<HydratedCommand | null> {
    const spec = this.validateSpec(input);
    const enabled = input.enabled !== false;
    const id = `ccmd_${nanoid(8)}`;
    try {
      await this.db.insert(chatCommands).values({
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
      });
    } catch (err) {
      if (/UNIQUE/i.test((err as Error).message)) {
        throw new ConflictException(
          `A command named "${spec.trigger}" already exists on this server`,
        );
      }
      throw err;
    }
    this.cache.invalidate(serverId);
    this.events.recordEvent({
      serverId,
      actor,
      type: 'chat-command-config',
      summary: `Chat command ${await this.getPrefix(serverId)}${spec.trigger} created (${this.actionSummary(spec)})`,
      details: { id, ...spec },
    });
    return this.getCommand(serverId, id);
  }

  async updateCommand(
    serverId: string,
    cmdId: string,
    changes: CommandChanges,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<HydratedCommand | null> {
    const existing = await this.getCommand(serverId, cmdId);
    if (!existing) throw new NotFoundException('Chat command not found');

    // Enabled-only toggles skip full re-validation (fast path for the UI toggle).
    const keys = (Object.keys(changes) as (keyof CommandChanges)[]).filter(
      (k) => changes[k] !== undefined,
    );
    if (keys.length === 1 && keys[0] === 'enabled') {
      await this.db
        .update(chatCommands)
        .set({ enabled: Boolean(changes.enabled) })
        .where(eq(chatCommands.id, cmdId));
      this.cache.invalidate(serverId);
      this.events.recordEvent({
        serverId,
        actor,
        type: 'chat-command-config',
        summary: `Chat command ${await this.getPrefix(serverId)}${existing.trigger} ${changes.enabled ? 'enabled' : 'disabled'}`,
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
      await this.db
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
        .where(eq(chatCommands.id, cmdId));
    } catch (err) {
      if (/UNIQUE/i.test((err as Error).message)) {
        throw new ConflictException(
          `A command named "${spec.trigger}" already exists on this server`,
        );
      }
      throw err;
    }
    this.cache.invalidate(serverId);
    this.events.recordEvent({
      serverId,
      actor,
      type: 'chat-command-config',
      summary: `Chat command ${await this.getPrefix(serverId)}${spec.trigger} updated (${this.actionSummary(spec)})`,
      details: { id: cmdId, ...spec, enabled },
    });
    return this.getCommand(serverId, cmdId);
  }

  async deleteCommand(
    serverId: string,
    cmdId: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<{ deleted: true }> {
    const existing = await this.getCommand(serverId, cmdId);
    if (!existing) throw new NotFoundException('Chat command not found');
    await this.db.delete(chatCommands).where(eq(chatCommands.id, cmdId));
    this.cache.invalidate(serverId);
    this.events.recordEvent({
      serverId,
      actor,
      type: 'chat-command-config',
      summary: `Chat command ${await this.getPrefix(serverId)}${existing.trigger} deleted`,
      details: { id: cmdId, trigger: existing.trigger },
    });
    return { deleted: true };
  }

  /** "rtp 500-5000" / "structure #minecraft:village" / "console ×2" — for events + UI. */
  actionSummary(cmd: { action: ChatAction; params: ActionParams }): string {
    const p = cmd.params || {};
    if (cmd.action === 'rtp')
      return `rtp ${p.minDistance ?? 500}-${p.maxDistance ?? 5000}${p.center === 'origin' ? ' around 0,0' : ''}`;
    if (cmd.action === 'structure')
      return `structure ${String(p.structure || '').replace(/^#/, '')}${p.random === false ? ' (nearest)' : ''}`;
    if (cmd.action === 'biome') return `biome ${p.biome || ''}`;
    return `console ×${Array.isArray(p.commands) ? p.commands.length : 0}`;
  }

  /** Bump a command's usage counter after a successful run and invalidate its
   * server's runtime cache entry — called by `ChatCommandsRuntimeService`
   * after `handleChat`/`testCommand` execute a command. */
  async bumpUsage(serverId: string, cmd: HydratedCommand): Promise<void> {
    await this.db
      .update(chatCommands)
      .set({
        uses: sql`${chatCommands.uses} + 1`,
        lastUsedAt: sql`(datetime('now'))`,
      })
      .where(eq(chatCommands.id, cmd.id));
    this.cache.invalidate(serverId);
  }

  readonly TRIGGER_RE = TRIGGER_RE;
  readonly PREFIX_RE = PREFIX_RE;
  readonly DANGEROUS_RE = DANGEROUS_RE;
}
