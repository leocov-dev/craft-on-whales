/** One classified console-log line, as returned by LogClassifierService.classify(). */
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
