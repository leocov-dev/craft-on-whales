/** `GET /api/servers/:id/analytics/timeline` row shape. */
export interface TimelineEvent {
  id: number;
  ts: string;
  type: string;
  player: string | null;
  target: string | null;
  message: string | null;
}

export type ScoreboardMetric =
  | 'playtimeTicks'
  | 'deaths'
  | 'mobKills'
  | 'playerKills'
  | 'blocksMinedTotal'
  | 'stoneMined'
  | 'diamondsMined'
  | 'ironMined'
  | 'ancientDebrisMined'
  | 'distanceCm'
  | 'damageDealt'
  | 'damageTaken'
  | 'jumps'
  | 'blocksUsedTotal';

/** `GET /api/servers/:id/analytics/scoreboard` row shape. */
export interface ScoreboardRow {
  uuid: string;
  name: string;
  value: number;
  rank: number;
  crown: boolean;
}
