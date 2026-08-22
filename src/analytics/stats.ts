'use strict';

// Player statistics: curates the world's vanilla stat files into flat
// snapshots (player_stat_snapshots), and derives profiles, scoreboards, and
// the advisory X-ray report from them.

import type { CuratedStats, PlayerStatSnapshotRow } from './types';

const fs = require('node:fs');
const path = require('node:path');
const { dbApi: db } = require('../db');
const { dataPath } = require('../storage/pathGuard');
const serversService = require('../services/servers');
const { activeLevelName } = require('../services/worlds');
const { uuidToDashed } = require('../services/mojangProfiles');

const RUNNING = new Set(['running', 'starting', 'unhealthy']);
const STONE_BLOCKS = ['minecraft:stone', 'minecraft:cobblestone', 'minecraft:deepslate', 'minecraft:cobbled_deepslate'];
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

let timer: ReturnType<typeof setInterval> | null = null;

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const sumAll = (obj: Record<string, unknown> | null | undefined): number => {
  let n = 0;
  for (const v of Object.values(obj || {})) n += num(v);
  return n;
};
const pick = (obj: Record<string, unknown> | null | undefined, keys: string[]): number =>
  keys.reduce((n, k) => n + num(obj && obj[k]), 0);

/** Vanilla stats JSON -> curated flat object (stable key order for diffing). */
function curate(root: { stats?: Record<string, Record<string, unknown>> } | null | undefined): CuratedStats {
  const stats = (root && root.stats) || {};
  const custom = stats['minecraft:custom'] || {};
  const mined = stats['minecraft:mined'] || {};
  let distanceCm = 0;
  for (const [key, value] of Object.entries(custom)) {
    if (key.endsWith('_one_cm')) distanceCm += num(value); // walk/sprint/swim/fly/boat/horse/…
  }
  return {
    playtimeTicks: num(custom['minecraft:play_time']) || num(custom['minecraft:play_one_minute']),
    deaths: num(custom['minecraft:deaths']),
    mobKills: num(custom['minecraft:mob_kills']),
    playerKills: num(custom['minecraft:player_kills']),
    damageDealt: num(custom['minecraft:damage_dealt']),
    damageTaken: num(custom['minecraft:damage_taken']),
    jumps: num(custom['minecraft:jump']),
    distanceCm,
    blocksMinedTotal: sumAll(mined),
    stoneMined: pick(mined, STONE_BLOCKS),
    diamondsMined: pick(mined, ['minecraft:diamond_ore', 'minecraft:deepslate_diamond_ore']),
    ironMined: pick(mined, ['minecraft:iron_ore', 'minecraft:deepslate_iron_ore']),
    ancientDebrisMined: num(mined['minecraft:ancient_debris']),
    // Vanilla has no "blocks placed" stat; minecraft:used counts right-click
    // uses per item, which is dominated by block placements — good builder proxy.
    blocksUsedTotal: sumAll(stats['minecraft:used']),
  };
}

function readUsercache(serverId: string): Map<string, string> {
  const names = new Map<string, string>();
  try {
    const rows = JSON.parse(fs.readFileSync(dataPath('servers', serverId, 'usercache.json'), 'utf8')) as {
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
 * Read <server>/<level>/stats/*.json and snapshot each player whose curated
 * stats changed since the last snapshot. Returns { players, snapshots }.
 */
function ingestStats(serverId: string): { players: number; snapshots: number } {
  const server = serversService.getServer(serverId);
  if (!server) {
    const err: Error & { status?: number } = new Error('Server not found');
    err.status = 404;
    throw err;
  }
  // activeLevelName honors LEVEL env AND server.properties level-name — a
  // renamed/activated world would otherwise silently stop producing stats.
  const level = activeLevelName(server);
  // MC 26.x moved stat files from <world>/stats to <world>/players/stats.
  let statsDir;
  try {
    const modern = dataPath('servers', serverId, level, 'players', 'stats');
    const legacy = dataPath('servers', serverId, level, 'stats');
    statsDir = fs.existsSync(modern) ? modern : legacy;
  } catch {
    return { players: 0, snapshots: 0 };
  }
  if (!fs.existsSync(statsDir)) return { players: 0, snapshots: 0 };

  const names = readUsercache(serverId);
  let players = 0;
  let snapshots = 0;
  for (const file of fs.readdirSync(statsDir) as string[]) {
    if (!file.endsWith('.json')) continue;
    const uuid = uuidToDashed(path.basename(file, '.json'));
    if (!uuid) continue;
    let curated;
    try {
      curated = curate(JSON.parse(fs.readFileSync(path.join(statsDir, file), 'utf8')));
    } catch {
      continue; // partial write / malformed file — retry next cycle
    }
    players++;
    const json = JSON.stringify(curated);
    const latest = db.get(
      'SELECT stats_json FROM player_stat_snapshots WHERE server_id = ? AND uuid = ? ORDER BY id DESC LIMIT 1',
      serverId,
      uuid
    );
    if (latest && latest.stats_json === json) continue;
    db.run(
      `INSERT INTO player_stat_snapshots (server_id, uuid, name, ts, stats_json)
       VALUES (?, ?, ?, ?, ?)`,
      serverId,
      uuid,
      names.get(uuid) || '',
      new Date().toISOString(),
      json
    );
    snapshots++;
  }
  return { players, snapshots };
}

/** Periodic stat ingestion for all running servers. Returns a stop function. */
function startStatsIngest({ intervalMs = 5 * 60 * 1000 }: { intervalMs?: number } = {}): () => void {
  const tick = () => {
    for (const server of serversService.listServers()) {
      if (!RUNNING.has(server.status)) continue;
      try {
        ingestStats(server.id);
      } catch (err) {
        console.error(`[analytics] stats ingest ${server.id} failed:`, err instanceof Error ? err.message : err);
      }
    }
  };
  tick();
  timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}

function latestSnapshot(serverId: string, uuid: string): PlayerStatSnapshotRow | undefined {
  return db.get(
    'SELECT * FROM player_stat_snapshots WHERE server_id = ? AND uuid = ? ORDER BY id DESC LIMIT 1',
    serverId,
    uuid
  );
}

/**
 * Baseline snapshot for windowed deltas: the newest snapshot at or before the
 * cutoff; when the player has none that old (snapshots only exist since
 * tracking started), the oldest snapshot stands in so deltas never exceed
 * what was actually observed.
 */
function baselineSnapshot(serverId: string, uuid: string, cutoffIso: string): PlayerStatSnapshotRow | undefined {
  return (
    db.get(
      `SELECT * FROM player_stat_snapshots WHERE server_id = ? AND uuid = ? AND ts <= ?
       ORDER BY ts DESC LIMIT 1`,
      serverId,
      uuid,
      cutoffIso
    ) ||
    db.get(
      'SELECT * FROM player_stat_snapshots WHERE server_id = ? AND uuid = ? ORDER BY ts ASC LIMIT 1',
      serverId,
      uuid
    )
  );
}

type Window = '24h' | '7d' | 'all';

function windowCutoff(window: Window): string | null {
  const hours = window === '24h' ? 24 : window === '7d' ? 24 * 7 : null;
  return hours ? new Date(Date.now() - hours * 3_600_000).toISOString() : null;
}

function deltaBetween(latest: CuratedStats, base: CuratedStats | null): CuratedStats {
  const out = {} as CuratedStats;
  for (const key of METRICS) out[key] = Math.max(0, num(latest[key]) - num(base ? base[key] : 0));
  return out;
}

/**
 * Playstyle heuristic (percentages of the four normalized scores):
 *   miner    = blocks broken
 *   builder  = minecraft:used total (right-click uses ≈ blocks placed; vanilla
 *              has no direct "placed" stat) — falls back to jumps when zero
 *   fighter  = 25 * (mobKills + 4 * playerKills) + damageDealt / 10
 *   explorer = distanceCm / 1600 (16 m traveled weighted like one block mined)
 * The scale factors put a typical hour of each activity in the same order of
 * magnitude so the split reflects how time is actually spent.
 */
function playstyle(stats: CuratedStats): Record<'miner' | 'builder' | 'fighter' | 'explorer', number> {
  const scores = {
    miner: stats.blocksMinedTotal,
    builder: stats.blocksUsedTotal > 0 ? stats.blocksUsedTotal : stats.jumps / 2,
    fighter: 25 * (stats.mobKills + 4 * stats.playerKills) + stats.damageDealt / 10,
    explorer: stats.distanceCm / 1600,
  };
  const total = Object.values(scores).reduce((n, v) => n + v, 0);
  const pct = {} as Record<'miner' | 'builder' | 'fighter' | 'explorer', number>;
  for (const [key, value] of Object.entries(scores) as [keyof typeof scores, number][]) {
    pct[key] = total > 0 ? Math.round((value / total) * 100) : 0;
  }
  return pct;
}

interface SessionSummary {
  startedAt: string;
  endedAt: string | null;
  durationSec: number;
  open: boolean;
}

interface PlayerProfile {
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

/** Full profile for one player: latest stats, 24h/7d deltas, playstyle, sessions. */
function profile(serverId: string, uuid: string): PlayerProfile | null {
  const dashed = uuidToDashed(uuid) || uuid;
  const row = latestSnapshot(serverId, dashed);
  if (!row) return null;
  const stats = JSON.parse(String(row.stats_json)) as CuratedStats;
  const deltas = {} as Record<'24h' | '7d', CuratedStats>;
  for (const window of ['24h', '7d'] as const) {
    const cutoff = windowCutoff(window);
    const base = cutoff ? baselineSnapshot(serverId, dashed, cutoff) : undefined;
    deltas[window] = deltaBetween(stats, base ? (JSON.parse(String(base.stats_json)) as CuratedStats) : null);
  }

  const name = row.name || '';
  const sessionAgg = name
    ? (db.get(
        `SELECT COUNT(*) AS count,
                SUM(CASE WHEN ended_at IS NOT NULL
                    THEN (julianday(ended_at) - julianday(started_at)) * 86400 ELSE 0 END) AS closed_seconds
         FROM player_sessions WHERE server_id = ? AND player = ?`,
        serverId,
        name
      ) as { count: number; closed_seconds: number })
    : { count: 0, closed_seconds: 0 };
  const recentSessions: SessionSummary[] = name
    ? (
        db.all(
          `SELECT started_at, ended_at FROM player_sessions WHERE server_id = ? AND player = ?
         ORDER BY started_at DESC LIMIT 10`,
          serverId,
          name
        ) as { started_at: string; ended_at: string | null }[]
      ).map((s) => ({
        startedAt: s.started_at,
        endedAt: s.ended_at,
        durationSec: Math.max(
          0,
          Math.round(
            ((s.ended_at ? Date.parse(String(s.ended_at)) : Date.now()) - Date.parse(String(s.started_at))) / 1000
          )
        ),
        open: !s.ended_at,
      }))
    : [];

  return {
    uuid: dashed,
    name,
    updatedAt: row.ts,
    stats,
    deltas,
    playstyle: playstyle(stats),
    playtimeSeconds: Math.round(stats.playtimeTicks / 20),
    sessions: {
      count: Number(sessionAgg.count) || 0,
      closedSeconds: Math.round(Number(sessionAgg.closed_seconds) || 0),
      last: recentSessions[0] || null,
      recent: recentSessions,
    },
  };
}

interface ScoreboardRow {
  uuid: string;
  name: string;
  value: number;
  rank: number;
  crown: boolean;
}

/** Rank every tracked player by one metric, absolute or windowed delta. */
function scoreboard(
  serverId: string,
  { metric = 'playtimeTicks', window = 'all' }: { metric?: keyof CuratedStats; window?: Window } = {}
): ScoreboardRow[] {
  if (!METRICS.has(metric)) {
    const err: Error & { status?: number } = new Error(`Unknown metric: ${metric}`);
    err.status = 400;
    throw err;
  }
  const cutoff = windowCutoff(window);
  const uuids = db.all('SELECT DISTINCT uuid FROM player_stat_snapshots WHERE server_id = ?', serverId) as {
    uuid: string;
  }[];
  const rows: Omit<ScoreboardRow, 'rank' | 'crown'>[] = [];
  for (const { uuid } of uuids) {
    const latest = latestSnapshot(serverId, uuid);
    if (!latest) continue;
    const stats = JSON.parse(String(latest.stats_json)) as CuratedStats;
    let value = num(stats[metric]);
    if (cutoff) {
      const base = baselineSnapshot(serverId, uuid, cutoff);
      value = Math.max(0, value - num(base ? (JSON.parse(String(base.stats_json)) as CuratedStats)[metric] : 0));
    }
    rows.push({ uuid, name: latest.name || String(uuid).slice(0, 8), value });
  }
  rows.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  return rows.map((row, i) => ({ ...row, rank: i + 1, crown: i === 0 && row.value > 0 }));
}

const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const midVal = sorted[mid] ?? 0;
  return sorted.length % 2 ? midVal : ((sorted[mid - 1] ?? 0) + midVal) / 2;
};

interface XrayPlayer {
  uuid: string;
  name: string;
  stoneMined: number;
  diamondsMined: number;
  ancientDebrisMined: number;
  diamondRatio: number;
  debrisRatio: number;
}

interface XrayFlaggedPlayer extends XrayPlayer {
  percentile: number;
  flagged: boolean;
  reasons: string[];
}

interface XrayReport {
  advisory: true;
  sampleSize: number;
  medianDiamondRatio: number;
  medianDebrisRatio: number;
  players: XrayFlaggedPlayer[];
  flagged: XrayFlaggedPlayer[];
}

/**
 * Advisory X-ray heuristic: each player's diamond/(stone+1) and ancient-debris
 * ratios vs the server median (players with >= 64 stone mined). Flags ratios
 * over 4x median with at least 16 diamonds — evidence only, never punitive.
 */
function xrayReport(serverId: string): XrayReport {
  const uuids = db.all('SELECT DISTINCT uuid FROM player_stat_snapshots WHERE server_id = ?', serverId) as {
    uuid: string;
  }[];
  const players: XrayPlayer[] = uuids
    .map(({ uuid }): XrayPlayer | null => {
      const latest = latestSnapshot(serverId, uuid);
      if (!latest) return null;
      const s = JSON.parse(String(latest.stats_json)) as CuratedStats;
      return {
        uuid,
        name: latest.name || String(uuid).slice(0, 8),
        stoneMined: s.stoneMined,
        diamondsMined: s.diamondsMined,
        ancientDebrisMined: s.ancientDebrisMined,
        diamondRatio: s.diamondsMined / (s.stoneMined + 1),
        debrisRatio: s.ancientDebrisMined / (s.stoneMined + 1),
      };
    })
    .filter((p): p is XrayPlayer => p !== null);

  const eligible = players.filter((p) => p.stoneMined >= 64);
  const medDiamond = median(eligible.map((p) => p.diamondRatio));
  const medDebris = median(eligible.map((p) => p.debrisRatio));
  // Floor keeps a lone miner on a fresh server from dividing by a zero median.
  const effDiamond = Math.max(medDiamond, 0.001);
  const effDebris = Math.max(medDebris, 0.0005);

  const ratios = players.map((p) => p.diamondRatio).sort((a, b) => a - b);
  const out: XrayFlaggedPlayer[] = players
    .map((p) => {
      const flaggedDiamond = p.stoneMined >= 64 && p.diamondsMined >= 16 && p.diamondRatio > 4 * effDiamond;
      const flaggedDebris = p.stoneMined >= 64 && p.ancientDebrisMined >= 8 && p.debrisRatio > 4 * effDebris;
      return {
        ...p,
        diamondRatio: Number(p.diamondRatio.toFixed(5)),
        debrisRatio: Number(p.debrisRatio.toFixed(5)),
        percentile:
          ratios.length > 1
            ? Math.round((ratios.filter((r) => r <= p.diamondRatio).length / ratios.length) * 100)
            : 100,
        flagged: flaggedDiamond || flaggedDebris,
        reasons: [
          ...(flaggedDiamond ? [`diamond ratio ${(p.diamondRatio / effDiamond).toFixed(1)}x server median`] : []),
          ...(flaggedDebris ? [`ancient debris ratio ${(p.debrisRatio / effDebris).toFixed(1)}x server median`] : []),
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

export { ingestStats, startStatsIngest, profile, scoreboard, xrayReport, curate };
