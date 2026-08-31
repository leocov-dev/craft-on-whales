import { BadRequestException, Injectable } from '@nestjs/common';
import { eq, and, desc, asc, lte, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import {
  playerStatSnapshots,
  playerSessions,
  playerEvents,
} from '../db/schema';
import { uuidToDashed } from './mojang-uuid.util';
import type { CuratedStats } from './types';
import type { ScoreboardRow as SharedScoreboardRow } from '../../../shared/types/analytics';
import { METRICS, num, type Window, type SnapshotRow } from './stats.util';

interface SessionSummary {
  startedAt: string;
  endedAt: string | null;
  durationSec: number;
  open: boolean;
}

export interface PlayerProfile {
  uuid: string;
  name: string;
  updatedAt: string;
  stats: CuratedStats;
  deltas: Record<'24h' | '7d', CuratedStats>;
  playstyle: Record<'miner' | 'builder' | 'fighter' | 'explorer', number>;
  playtimeSeconds: number;
  sessions: {
    count: number;
    closedSeconds: number;
    last: SessionSummary | null;
    recent: SessionSummary[];
  };
}

export type ScoreboardRow = SharedScoreboardRow;

/**
 * Read-side player analytics: profile assembly (latest stats + windowed
 * deltas + playstyle + session summary) and the ranked scoreboard. Ports the
 * profile/scoreboard half of legacy's src/analytics/stats.ts.
 */
@Injectable()
export class StatsProfileService {
  constructor(private readonly dbService: DbService) {}

  private get db() {
    return this.dbService.db;
  }

  private async latestSnapshot(
    serverId: string,
    uuid: string,
  ): Promise<SnapshotRow | undefined> {
    const [row] = await this.db
      .select()
      .from(playerStatSnapshots)
      .where(
        and(
          eq(playerStatSnapshots.serverId, serverId),
          eq(playerStatSnapshots.uuid, uuid),
        ),
      )
      .orderBy(desc(playerStatSnapshots.id))
      .limit(1);
    return row;
  }

  /**
   * Baseline snapshot for windowed deltas: the newest snapshot at or before
   * the cutoff; when the player has none that old (snapshots only exist
   * since tracking started), the oldest snapshot stands in so deltas never
   * exceed what was actually observed.
   */
  private async baselineSnapshot(
    serverId: string,
    uuid: string,
    cutoffIso: string,
  ): Promise<SnapshotRow | undefined> {
    const [before] = await this.db
      .select()
      .from(playerStatSnapshots)
      .where(
        and(
          eq(playerStatSnapshots.serverId, serverId),
          eq(playerStatSnapshots.uuid, uuid),
          lte(playerStatSnapshots.ts, cutoffIso),
        ),
      )
      .orderBy(desc(playerStatSnapshots.ts))
      .limit(1);
    if (before) return before;
    const [oldest] = await this.db
      .select()
      .from(playerStatSnapshots)
      .where(
        and(
          eq(playerStatSnapshots.serverId, serverId),
          eq(playerStatSnapshots.uuid, uuid),
        ),
      )
      .orderBy(asc(playerStatSnapshots.ts))
      .limit(1);
    return oldest;
  }

  private windowCutoff(window: Window): string | null {
    const hours = window === '24h' ? 24 : window === '7d' ? 24 * 7 : null;
    return hours
      ? new Date(Date.now() - hours * 3_600_000).toISOString()
      : null;
  }

  private deltaBetween(
    latest: CuratedStats,
    base: CuratedStats | null,
  ): CuratedStats {
    const out = {} as CuratedStats;
    for (const key of METRICS)
      out[key] = Math.max(0, num(latest[key]) - num(base ? base[key] : 0));
    return out;
  }

  /**
   * Playstyle heuristic (percentages of the four normalized scores):
   *   miner    = blocks broken
   *   builder  = minecraft:used total (right-click uses ≈ blocks placed; vanilla
   *              has no direct "placed" stat) — falls back to jumps when zero
   *   fighter  = 25 * (mobKills + 4 * playerKills) + damageDealt / 10
   *   explorer = distanceCm / 1600 (16 m traveled weighted like one block mined)
   * The scale factors put a typical hour of each activity in the same order
   * of magnitude so the split reflects how time is actually spent.
   */
  private playstyle(
    stats: CuratedStats,
  ): Record<'miner' | 'builder' | 'fighter' | 'explorer', number> {
    const scores = {
      miner: stats.blocksMinedTotal,
      builder:
        stats.blocksUsedTotal > 0 ? stats.blocksUsedTotal : stats.jumps / 2,
      fighter:
        25 * (stats.mobKills + 4 * stats.playerKills) + stats.damageDealt / 10,
      explorer: stats.distanceCm / 1600,
    };
    const total = Object.values(scores).reduce((n, v) => n + v, 0);
    const pct = {} as Record<
      'miner' | 'builder' | 'fighter' | 'explorer',
      number
    >;
    for (const [key, value] of Object.entries(scores) as [
      keyof typeof scores,
      number,
    ][]) {
      pct[key] = total > 0 ? Math.round((value / total) * 100) : 0;
    }
    return pct;
  }

  /** Full profile for one player: latest stats, 24h/7d deltas, playstyle, sessions. */
  async profile(serverId: string, uuid: string): Promise<PlayerProfile | null> {
    const dashed = uuidToDashed(uuid) || uuid;
    const row = await this.latestSnapshot(serverId, dashed);
    if (!row) return null;
    const stats = JSON.parse(row.statsJson) as CuratedStats;
    const deltas = {} as Record<'24h' | '7d', CuratedStats>;
    for (const window of ['24h', '7d'] as const) {
      const cutoff = this.windowCutoff(window);
      const base = cutoff
        ? await this.baselineSnapshot(serverId, dashed, cutoff)
        : undefined;
      deltas[window] = this.deltaBetween(
        stats,
        base ? (JSON.parse(base.statsJson) as CuratedStats) : null,
      );
    }

    const name = row.name || '';
    const sessionAgg = name
      ? await this.db
          .select({
            startedAt: playerSessions.startedAt,
            endedAt: playerSessions.endedAt,
          })
          .from(playerSessions)
          .where(
            and(
              eq(playerSessions.serverId, serverId),
              eq(playerSessions.player, name),
            ),
          )
      : [];
    const count = sessionAgg.length;
    const closedSeconds = sessionAgg.reduce(
      (n, s) =>
        n +
        (s.endedAt
          ? (Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 1000
          : 0),
      0,
    );
    const recentSessionRows = name
      ? await this.db
          .select({
            startedAt: playerSessions.startedAt,
            endedAt: playerSessions.endedAt,
          })
          .from(playerSessions)
          .where(
            and(
              eq(playerSessions.serverId, serverId),
              eq(playerSessions.player, name),
            ),
          )
          .orderBy(desc(playerSessions.startedAt))
          .limit(10)
      : [];
    const recentSessions: SessionSummary[] = recentSessionRows.map((s) => ({
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      durationSec: Math.max(
        0,
        Math.round(
          ((s.endedAt ? Date.parse(s.endedAt) : Date.now()) -
            Date.parse(s.startedAt)) /
            1000,
        ),
      ),
      open: !s.endedAt,
    }));

    return {
      uuid: dashed,
      name,
      updatedAt: row.ts,
      stats,
      deltas,
      playstyle: this.playstyle(stats),
      playtimeSeconds: Math.round(stats.playtimeTicks / 20),
      sessions: {
        count,
        closedSeconds: Math.round(closedSeconds),
        last: recentSessions[0] || null,
        recent: recentSessions,
      },
    };
  }

  /** Rank every tracked player by one metric, absolute or windowed delta. */
  async scoreboard(
    serverId: string,
    {
      metric = 'playtimeTicks',
      window = 'all',
    }: { metric?: keyof CuratedStats; window?: Window } = {},
  ): Promise<ScoreboardRow[]> {
    if (!METRICS.has(metric))
      throw new BadRequestException(`Unknown metric: ${metric}`);
    const cutoff = this.windowCutoff(window);
    const uuids = await this.db
      .selectDistinct({ uuid: playerStatSnapshots.uuid })
      .from(playerStatSnapshots)
      .where(eq(playerStatSnapshots.serverId, serverId));
    const rows: Omit<ScoreboardRow, 'rank' | 'crown'>[] = [];
    for (const { uuid } of uuids) {
      const latest = await this.latestSnapshot(serverId, uuid);
      if (!latest) continue;
      const stats = JSON.parse(latest.statsJson) as CuratedStats;
      let value = num(stats[metric]);
      if (cutoff) {
        const base = await this.baselineSnapshot(serverId, uuid, cutoff);
        value = Math.max(
          0,
          value -
            num(
              base ? (JSON.parse(base.statsJson) as CuratedStats)[metric] : 0,
            ),
        );
      }
      rows.push({ uuid, name: latest.name || uuid.slice(0, 8), value });
    }
    rows.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
    return rows.map((row, i) => ({
      ...row,
      rank: i + 1,
      crown: i === 0 && row.value > 0,
    }));
  }

  /** Distinct players seen in the timeline plus everyone with stat snapshots. Ports the `/players` route's inline query. */
  async playersList(
    serverId: string,
  ): Promise<{ name: string; uuid: string }[]> {
    const fromEventsRows = await this.db
      .selectDistinct({ name: playerEvents.player })
      .from(playerEvents)
      .where(
        and(
          eq(playerEvents.serverId, serverId),
          sql`${playerEvents.player} != '' AND ${playerEvents.player} != '[Server]'`,
        ),
      );
    const fromEvents = fromEventsRows.map((r) => ({ name: r.name, uuid: '' }));
    const fromSnapshots = await this.db
      .selectDistinct({
        name: playerStatSnapshots.name,
        uuid: playerStatSnapshots.uuid,
      })
      .from(playerStatSnapshots)
      .where(
        and(
          eq(playerStatSnapshots.serverId, serverId),
          sql`${playerStatSnapshots.name} != ''`,
        ),
      );
    const byName = new Map<string, { name: string; uuid: string }>();
    for (const p of [...fromEvents, ...fromSnapshots]) {
      if (!byName.has(p.name) || p.uuid) byName.set(p.name, p);
    }
    return [...byName.values()].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
  }
}
