import {
  BadGatewayException,
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import { ContainerService } from '../docker/container.service';
import { rcon } from '../utils/rcon';
import { EventsService } from '../events/events.service';
import { ServerPropertiesService } from '../servers/server-properties.service';
import { GAMERULES, QUICK_ACTIONS } from './world-controls.constants';
import type {
  GameruleKey,
  RunQuickResult,
  TimeInfo,
  WorldState,
} from './world-controls.types';

const looksLikeError = (out: string): boolean =>
  /Incorrect argument|Unknown command|Can't find element|Expected|<--\[HERE\]/i.test(
    out,
  );

/**
 * World quick-controls (time/weather/gamerules/difficulty) — version-tolerant:
 * MC 26.x renamed gamerules to snake_case (keep_inventory) and moved /time to
 * timelines ("time query day"); ≤1.21 uses camelCase + "time query daytime".
 * Every op tries the modern form first and falls back to legacy. Ports
 * `src/services/worldControls.ts`.
 *
 * Kept as its own module rather than folded into WorldsModule: this is an
 * RCON-command-driven concern (gamerules/time/weather/difficulty), distinct
 * from the server.properties file, which belongs to ServerPropertiesService.
 * Two actions cross that line: `pvp`, which has no gamerule and lives only
 * in the file, and `difficulty`, which is an RCON command whose result must
 * also be written to the file so it survives a restart.
 */
@Injectable()
export class WorldControlsService {
  constructor(
    private readonly containers: ContainerService,
    private readonly events: EventsService,
    private readonly properties: ServerPropertiesService,
  ) {}

  /** Run modern args; fall back to legacy args when the syntax is rejected. */
  private async tryVariants(
    serverId: string,
    variants: string[][],
  ): Promise<string> {
    let out = '';
    for (const args of variants) {
      out = await rcon(this.containers, serverId, args);
      if (!looksLikeError(out)) return out;
    }
    return out;
  }

  private async queryGamerule(
    serverId: string,
    rule: GameruleKey,
  ): Promise<boolean | null> {
    const out = await this.tryVariants(serverId, [
      ['gamerule', GAMERULES[rule]], // 26.x snake_case
      ['gamerule', rule], // legacy camelCase
    ]);
    const m =
      /(?:is currently set to|is):?\s*(true|false)/i.exec(out) ||
      /\b(true|false)\s*$/i.exec(out.trim());
    return m ? m[1]?.toLowerCase() === 'true' : null;
  }

  private async setGamerule(
    serverId: string,
    rule: GameruleKey,
    value: 'true' | 'false',
  ): Promise<string> {
    return this.tryVariants(serverId, [
      ['gamerule', GAMERULES[rule], value],
      ['gamerule', rule, value],
    ]);
  }

  /** 0–23999 daytime ticks → "1:04 PM" (0 ticks = 6:00 AM in Minecraft). */
  private clockFromTicks(ticks: number): string {
    const h24 = Math.floor(ticks / 1000 + 6) % 24;
    const minutes = Math.floor(((ticks % 1000) / 1000) * 60);
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${h12}:${String(minutes).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
  }

  private async queryTime(serverId: string): Promise<TimeInfo | null> {
    const out = await this.tryVariants(serverId, [
      ['time', 'query', 'daytime'], // ≤1.21: "The time is N"
      ['time', 'query', 'day'], // 26.x: "Timeline minecraft:day is at N tick(s)"
    ]);
    const m = /The time is (\d+)/i.exec(out) || /is at (\d+) tick/i.exec(out);
    if (!m || !m[1]) return null;
    const ticks = Number(m[1]) % 24000;
    const label =
      ticks < 6000
        ? 'Morning'
        : ticks < 12000
          ? 'Afternoon'
          : ticks < 13800
            ? 'Sunset'
            : ticks < 22200
              ? 'Night'
              : 'Sunrise';
    return { ticks, label, clock: this.clockFromTicks(ticks) };
  }

  /** World day counter from total game time (works on ≤1.21 and 26.x). */
  private async queryDay(serverId: string): Promise<number | null> {
    const out = await rcon(this.containers, serverId, [
      'time',
      'query',
      'gametime',
    ]);
    // ≤1.21: "The time is N" · 26.x: "The game time is N tick(s)"
    const m =
      /(?:game time is|The time is)\s*(\d+)/i.exec(out) ||
      /is at (\d+) tick/i.exec(out);
    return m && m[1] ? Math.floor(Number(m[1]) / 24000) + 1 : null;
  }

  // PvP isn't a gamerule — it's the server.properties `pvp` value, applied
  // at (re)start and then in force for everyone, including players who join
  // later. There is no vanilla live+permanent global switch; that needs a
  // server mod/plugin with engine access. Writing it goes through
  // ServerPropertiesService, which also clears a PVP env var so the image
  // stops reverting the edit on every start.
  private readPvp(serverId: string): boolean {
    const value = this.properties.get(serverId, 'pvp');
    return value === undefined ? true : value !== 'false'; // vanilla default is on
  }

  async getState(serverId: string): Promise<WorldState> {
    const state: WorldState = { pvp: true };
    const time = await this.queryTime(serverId);
    if (time) {
      state.timeTicks = time.ticks;
      state.timeLabel = time.label;
      state.clock = time.clock;
      try {
        state.day = await this.queryDay(serverId);
      } catch {
        /* clock still works without a day count */
      }
    }
    for (const rule of Object.keys(GAMERULES) as GameruleKey[]) {
      const value = await this.queryGamerule(serverId, rule);
      if (value !== null) state[rule] = value;
    }
    state.pvp = this.readPvp(serverId); // from server.properties — the pending/effective value
    return state;
  }

  async runQuick(
    serverId: string,
    action: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<RunQuickResult> {
    const quick = QUICK_ACTIONS[action];
    if (!quick)
      throw new BadRequestException(`Unknown quick action: ${action}`);
    let out: string;
    if ('prop' in quick) {
      // server.properties edit — takes effect on next restart
      await this.properties.setProperty(
        serverId,
        quick.prop,
        String(quick.value),
        { actor },
      );
      out = '';
    } else if ('variants' in quick)
      out = await this.tryVariants(serverId, quick.variants);
    else if ('rule' in quick)
      out = await this.setGamerule(serverId, quick.rule, quick.value);
    else out = await rcon(this.containers, serverId, quick.cmd);
    // `/difficulty` changes the running game only; the file is what the
    // server reads on boot, so write it too or the change dies at restart.
    if (
      'cmd' in quick &&
      quick.cmd[0] === 'difficulty' &&
      !looksLikeError(out)
    ) {
      const level = quick.cmd[1];
      if (level)
        await this.properties.setProperty(serverId, 'difficulty', level, {
          actor,
        });
    }
    // A server.properties edit isn't an RCON command — skip the RCON error gate.
    if (!('prop' in quick) && looksLikeError(out)) {
      throw new BadGatewayException(
        `The server rejected the command: ${out.split('\n')[0]}`,
      );
    }
    this.events.recordEvent({
      serverId,
      actor,
      type: 'rcon',
      summary: `Quick action: ${quick.label}`,
      details: { action, output: out.slice(0, 300) },
    });
    return { label: quick.label, output: out.trim() };
  }
}
