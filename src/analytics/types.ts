'use strict';

// Shared types for src/analytics. Extracted to their own file (rather than
// living alongside a CommonJS `export =` in ingest.ts/logClassifier.ts/
// stats.ts) because tsx's esbuild-based CJS loader transforms each file
// independently and can silently drop type-only exports mixed into a file
// that also has an `export =` value statement (see src/db/types.ts).

/** One classified console-log line, as returned by logClassifier's classify(). */
export interface ClassifiedEvent {
  /** HH:MM:SS from the log prefix, or null when the line had none. */
  time: string | null;
  type: 'chat' | 'join' | 'leave' | 'advancement' | 'death';
  player: string;
  target: string;
  message: string;
  /** True for a secondary variant of an event that also appears as a canonical line. */
  dedupe?: boolean;
}

/** A `player_events` row (see db/migrations/002_parity.ts). */
export interface PlayerEventRow {
  id: number;
  server_id: string;
  ts: string;
  type: string;
  player: string;
  target: string;
  message: string;
  raw: string;
}

/** A `player_sessions` row (see db/migrations/002_parity.ts). */
export interface PlayerSessionRow {
  id: number;
  server_id: string;
  player: string;
  started_at: string;
  ended_at: string | null;
}

/** Curated flat stats, the shape stored (JSON-encoded) in player_stat_snapshots.stats_json. */
export interface CuratedStats {
  playtimeTicks: number;
  deaths: number;
  mobKills: number;
  playerKills: number;
  damageDealt: number;
  damageTaken: number;
  jumps: number;
  distanceCm: number;
  blocksMinedTotal: number;
  stoneMined: number;
  diamondsMined: number;
  ironMined: number;
  ancientDebrisMined: number;
  blocksUsedTotal: number;
}

/** A `player_stat_snapshots` row (see db/migrations/002_parity.ts). */
export interface PlayerStatSnapshotRow {
  id: number;
  server_id: string;
  uuid: string;
  name: string;
  ts: string;
  stats_json: string;
}
