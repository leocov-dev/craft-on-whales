import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { eq, and, desc, asc, lte, lt, or, like, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import {
  playerStatSnapshots,
  playerSessions,
  playerEvents,
} from '../db/schema';
import { ServerQueryService } from '../servers/server-query.service';
import { PathGuardService } from '../storage/path-guard.service';
import { WorldPropsService } from '../worlds/world-props.service';
import { uuidToDashed } from './mojang-uuid.util';
import type { CuratedStats } from './types';
import type {
  TimelineEvent,
  ScoreboardRow as SharedScoreboardRow,
} from '../../../shared/types/analytics';

const RUNNING = new Set(['running', 'starting', 'unhealthy']);
const STONE_BLOCKS = [
  'minecraft:stone',
  'minecraft:cobblestone',
  'minecraft:deepslate',
  'minecraft:cobbled_deepslate',
];
const METRICS = new Set<keyof CuratedStats>([
  'playtimeTicks',
  'deaths',
  'mobKills',
  'playerKills',
  'blocksMinedTotal',
  'stoneMined',
  'diamondsMined',
  'ironMined',
  'ancientDebrisMined',
  'distanceCm',
  'damageDealt',
  'damageTaken',
  'jumps',
  'blocksUsedTotal',
]);

const num = (v: unknown): number =>
  Number.isFinite(Number(v)) ? Number(v) : 0;
const sumAll = (obj: Record<string, unknown> | null | undefined): number => {
  let n = 0;
  for (const v of Object.values(obj || {})) n += num(v);
  return n;
};
const pick = (
  obj: Record<string, unknown> | null | undefined,
  keys: string[],
): number => keys.reduce((n, k) => n + num(obj && obj[k]), 0);

type Window = '24h' | '7d' | 'all';

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

interface XrayPlayer {
  uuid: string;
  name: string;
  stoneMined: number;
  diamondsMined: number;
  ancientDebrisMined: number;
  diamondRatio: number;
  debrisRatio: number;
}

export interface XrayFlaggedPlayer extends XrayPlayer {
  percentile: number;
  flagged: boolean;
  reasons: string[];
}

export interface XrayReport {
  advisory: true;
  sampleSize: number;
  medianDiamondRatio: number;
  medianDebrisRatio: number;
  players: XrayFlaggedPlayer[];
  flagged: XrayFlaggedPlayer[];
}

type SnapshotRow = typeof playerStatSnapshots.$inferSelect;

/**
 * Player statistics: curates the world's vanilla stat files into flat
 * snapshots (player_stat_snapshots), and derives profiles, scoreboards, and
 * the advisory X-ray report from them. Ports src/analytics/stats.ts.
 */
@Injectable()
export class StatsService implements OnModuleInit {
  private readonly logger = new Logger(StatsService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly dbService: DbService,
    private readonly pathGuard: PathGuardService,
    private readonly servers: ServerQueryService,
    private readonly worldProps: WorldPropsService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  onModuleInit(): void {
    // Fire-and-forget, matching legacy's boot-time `startStatsIngest({})` call.
    this.startStatsIngest();
  }

  /** Vanilla stats JSON -> curated flat object (stable key order for diffing). */
  private curate(
    root:
      { stats?: Record<string, Record<string, unknown>> } | null | undefined,
  ): CuratedStats {
    const stats = (root && root.stats) || {};
    const custom = stats['minecraft:custom'] || {};
    const mined = stats['minecraft:mined'] || {};
    let distanceCm = 0;
    for (const [key, value] of Object.entries(custom)) {
      if (key.endsWith('_one_cm')) distanceCm += num(value); // walk/sprint/swim/fly/boat/horse/…
    }
    return {
      playtimeTicks:
        num(custom['minecraft:play_time']) ||
        num(custom['minecraft:play_one_minute']),
      deaths: num(custom['minecraft:deaths']),
      mobKills: num(custom['minecraft:mob_kills']),
      playerKills: num(custom['minecraft:player_kills']),
      damageDealt: num(custom['minecraft:damage_dealt']),
      damageTaken: num(custom['minecraft:damage_taken']),
      jumps: num(custom['minecraft:jump']),
      distanceCm,
      blocksMinedTotal: sumAll(mined),
      stoneMined: pick(mined, STONE_BLOCKS),
      diamondsMined: pick(mined, [
        'minecraft:diamond_ore',
        'minecraft:deepslate_diamond_ore',
      ]),
      ironMined: pick(mined, [
        'minecraft:iron_ore',
        'minecraft:deepslate_iron_ore',
      ]),
      ancientDebrisMined: num(mined['minecraft:ancient_debris']),
      // Vanilla has no "blocks placed" stat; minecraft:used counts right-click
      // uses per item, which is dominated by block placements — good builder proxy.
      blocksUsedTotal: sumAll(stats['minecraft:used']),
    };
  }

  private readUsercache(serverId: string): Map<string, string> {
    const names = new Map<string, string>();
    try {
      const rows = JSON.parse(
        fs.readFileSync(
          this.pathGuard.dataPath('servers', serverId, 'usercache.json'),
          'utf8',
        ),
      ) as {
        uuid: string;
        name: string;
      }[];
      for (const row of rows) {
        const uuid = uuidToDashed(row.uuid);
        if (uuid && row.name) names.set(uuid, row.name);
      }
    } catch {
      /* no usercache yet */
    }
    return names;
  }

  /**
   * Read <server>/<level>/stats/*.json and snapshot each player whose
   * curated stats changed since the last snapshot. Returns { players, snapshots }.
   */
  async ingestStats(
    serverId: string,
  ): Promise<{ players: number; snapshots: number }> {
    const server = await this.servers.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');
    // activeLevelName honors LEVEL env AND server.properties level-name — a
    // renamed/activated world would otherwise silently stop producing stats.
    const level = this.worldProps.activeLevelName(server);
    // MC 26.x moved stat files from <world>/stats to <world>/players/stats.
    let statsDir: string;
    try {
      const modern = this.pathGuard.dataPath(
        'servers',
        serverId,
        level,
        'players',
        'stats',
      );
      const legacy = this.pathGuard.dataPath(
        'servers',
        serverId,
        level,
        'stats',
      );
      statsDir = fs.existsSync(modern) ? modern : legacy;
    } catch {
      return { players: 0, snapshots: 0 };
    }
    if (!fs.existsSync(statsDir)) return { players: 0, snapshots: 0 };

    const names = this.readUsercache(serverId);
    let players = 0;
    let snapshots = 0;
    for (const file of fs.readdirSync(statsDir)) {
      if (!file.endsWith('.json')) continue;
      const uuid = uuidToDashed(path.basename(file, '.json'));
      if (!uuid) continue;
      let curated: CuratedStats;
      try {
        curated = this.curate(
          JSON.parse(fs.readFileSync(path.join(statsDir, file), 'utf8')),
        );
      } catch {
        continue; // partial write / malformed file — retry next cycle
      }
      players++;
      const json = JSON.stringify(curated);
      const [latest] = await this.db
        .select({ statsJson: playerStatSnapshots.statsJson })
        .from(playerStatSnapshots)
        .where(
          and(
            eq(playerStatSnapshots.serverId, serverId),
            eq(playerStatSnapshots.uuid, uuid),
          ),
        )
        .orderBy(desc(playerStatSnapshots.id))
        .limit(1);
      if (latest && latest.statsJson === json) continue;
      await this.db.insert(playerStatSnapshots).values({
        serverId,
        uuid,
        name: names.get(uuid) || '',
        ts: new Date().toISOString(),
        statsJson: json,
      });
      snapshots++;
    }
    return { players, snapshots };
  }

  /** Periodic stat ingestion for all running servers. Returns a stop function. */
  startStatsIngest({
    intervalMs = 5 * 60 * 1000,
  }: { intervalMs?: number } = {}): () => void {
    const tick = async () => {
      for (const server of await this.servers.listServers()) {
        if (!RUNNING.has(server.status)) continue;
        try {
          await this.ingestStats(server.id);
        } catch (err) {
          this.logger.error(
            `stats ingest ${server.id} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    };
    tick().catch((err: unknown) =>
      this.logger.error(
        `stats ingest tick failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    this.timer = setInterval(() => {
      tick().catch((err: unknown) =>
        this.logger.error(
          `stats ingest tick failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, intervalMs);
    this.timer.unref?.();
    return () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    };
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

  private median(values: number[]): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const midVal = sorted[mid] ?? 0;
    return sorted.length % 2 ? midVal : ((sorted[mid - 1] ?? 0) + midVal) / 2;
  }

  /**
   * Advisory X-ray heuristic: each player's diamond/(stone+1) and
   * ancient-debris ratios vs the server median (players with >= 64 stone
   * mined). Flags ratios over 4x median with at least 16 diamonds —
   * evidence only, never punitive.
   */
  async xrayReport(serverId: string): Promise<XrayReport> {
    const uuids = await this.db
      .selectDistinct({ uuid: playerStatSnapshots.uuid })
      .from(playerStatSnapshots)
      .where(eq(playerStatSnapshots.serverId, serverId));
    const playersRaw = await Promise.all(
      uuids.map(async ({ uuid }): Promise<XrayPlayer | null> => {
        const latest = await this.latestSnapshot(serverId, uuid);
        if (!latest) return null;
        const s = JSON.parse(latest.statsJson) as CuratedStats;
        return {
          uuid,
          name: latest.name || uuid.slice(0, 8),
          stoneMined: s.stoneMined,
          diamondsMined: s.diamondsMined,
          ancientDebrisMined: s.ancientDebrisMined,
          diamondRatio: s.diamondsMined / (s.stoneMined + 1),
          debrisRatio: s.ancientDebrisMined / (s.stoneMined + 1),
        };
      }),
    );
    const players: XrayPlayer[] = playersRaw.filter(
      (p): p is XrayPlayer => p !== null,
    );

    const eligible = players.filter((p) => p.stoneMined >= 64);
    const medDiamond = this.median(eligible.map((p) => p.diamondRatio));
    const medDebris = this.median(eligible.map((p) => p.debrisRatio));
    // Floor keeps a lone miner on a fresh server from dividing by a zero median.
    const effDiamond = Math.max(medDiamond, 0.001);
    const effDebris = Math.max(medDebris, 0.0005);

    const ratios = players.map((p) => p.diamondRatio).sort((a, b) => a - b);
    const out: XrayFlaggedPlayer[] = players
      .map((p) => {
        const flaggedDiamond =
          p.stoneMined >= 64 &&
          p.diamondsMined >= 16 &&
          p.diamondRatio > 4 * effDiamond;
        const flaggedDebris =
          p.stoneMined >= 64 &&
          p.ancientDebrisMined >= 8 &&
          p.debrisRatio > 4 * effDebris;
        return {
          ...p,
          diamondRatio: Number(p.diamondRatio.toFixed(5)),
          debrisRatio: Number(p.debrisRatio.toFixed(5)),
          percentile:
            ratios.length > 1
              ? Math.round(
                  (ratios.filter((r) => r <= p.diamondRatio).length /
                    ratios.length) *
                    100,
                )
              : 100,
          flagged: flaggedDiamond || flaggedDebris,
          reasons: [
            ...(flaggedDiamond
              ? [
                  `diamond ratio ${(p.diamondRatio / effDiamond).toFixed(1)}x server median`,
                ]
              : []),
            ...(flaggedDebris
              ? [
                  `ancient debris ratio ${(p.debrisRatio / effDebris).toFixed(1)}x server median`,
                ]
              : []),
          ],
        };
      })
      .sort((a, b) => b.diamondRatio - a.diamondRatio);

    return {
      advisory: true,
      sampleSize: eligible.length,
      medianDiamondRatio: Number(medDiamond.toFixed(5)),
      medianDebrisRatio: Number(medDebris.toFixed(5)),
      players: out,
      flagged: out.filter((p) => p.flagged),
    };
  }

  private static readonly EVENT_TYPES = [
    'chat',
    'join',
    'leave',
    'death',
    'advancement',
    'pvp',
    'command',
  ];

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
        .filter((t) => StatsService.EVENT_TYPES.includes(t));
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
