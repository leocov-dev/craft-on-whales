import type { playerStatSnapshots } from '../db/schema';
import type { CuratedStats } from './types';

export type Window = '24h' | '7d' | 'all';

export type SnapshotRow = typeof playerStatSnapshots.$inferSelect;

export const METRICS = new Set<keyof CuratedStats>([
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

export const num = (v: unknown): number =>
  Number.isFinite(Number(v)) ? Number(v) : 0;

export const sumAll = (
  obj: Record<string, unknown> | null | undefined,
): number => {
  let n = 0;
  for (const v of Object.values(obj || {})) n += num(v);
  return n;
};

export const pick = (
  obj: Record<string, unknown> | null | undefined,
  keys: string[],
): number => keys.reduce((n, k) => n + num(obj && obj[k]), 0);
