import { Injectable } from '@nestjs/common';
import { eq, and, desc, lt, or, like, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { playerSessions, playerEvents } from '../db/schema';
import type { TimelineEvent } from '../../../shared/types/analytics';

/**
 * Paginated read APIs for the server's history tab: the player_events
 * timeline feed and the join/leave sessions list. Ports the `/timeline` and
 * `/sessions` routes' inline queries from legacy's src/analytics/stats.ts.
 */
@Injectable()
export class StatsTimelineService {
  private static readonly EVENT_TYPES = [
    'chat',
    'join',
    'leave',
    'death',
    'advancement',
    'pvp',
    'command',
  ];

  constructor(private readonly dbService: DbService) {}

  private get db() {
    return this.dbService.db;
  }

  /** Paginated player_events feed for the server's history tab. Ports the `/timeline` route's inline query. */
  async timeline(
    serverId: string,
    {
      q,
      type,
      player,
      limit = 50,
      before,
    }: {
      q?: string;
      type?: string;
      player?: string;
      limit?: number;
      before?: number;
    },
  ): Promise<{ events: TimelineEvent[]; nextBefore: number | null }> {
    const clauses = [eq(playerEvents.serverId, serverId)];
    if (type) {
      const types = type
        .split(',')
        .map((t) => t.trim())
        .filter((t) => StatsTimelineService.EVENT_TYPES.includes(t));
      if (types.length) clauses.push(sql`${playerEvents.type} IN ${types}`);
    }
    if (player) clauses.push(eq(playerEvents.player, player));
    if (before) clauses.push(lt(playerEvents.id, before));
    if (q)
      clauses.push(
        or(
          like(playerEvents.message, `%${q}%`),
          like(playerEvents.player, `%${q}%`),
        )!,
      );
    const events = (await this.db
      .select({
        id: playerEvents.id,
        ts: playerEvents.ts,
        type: playerEvents.type,
        player: playerEvents.player,
        target: playerEvents.target,
        message: playerEvents.message,
      })
      .from(playerEvents)
      .where(and(...clauses))
      .orderBy(desc(playerEvents.id))
      .limit(limit)) as (typeof playerEvents.$inferSelect)[];
    return {
      events,
      nextBefore:
        events.length === limit ? events[events.length - 1]!.id : null,
    };
  }

  /** Join/leave session list for the server's history tab. Ports the `/sessions` route's inline query. */
  async sessionsList(serverId: string, player?: string) {
    const clauses = [eq(playerSessions.serverId, serverId)];
    if (player) clauses.push(eq(playerSessions.player, player));
    const rows = await this.db
      .select({
        id: playerSessions.id,
        player: playerSessions.player,
        startedAt: playerSessions.startedAt,
        endedAt: playerSessions.endedAt,
      })
      .from(playerSessions)
      .where(and(...clauses))
      .orderBy(desc(playerSessions.startedAt))
      .limit(100);
    return rows.map((s) => ({
      id: s.id,
      player: s.player,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      open: !s.endedAt,
      durationSec: Math.max(
        0,
        Math.round(
          ((s.endedAt ? Date.parse(s.endedAt) : Date.now()) -
            Date.parse(s.startedAt)) /
            1000,
        ),
      ),
    }));
  }
}
