// `GameruleKey`, `WorldState`, and `RunQuickResult` are cross-boundary shapes
// (the frontend's gamerule toggle table needs the exact same 43-key union) —
// defined once in shared/types/world-controls.d.ts and re-exported here
// rather than duplicated. See that file for the full grouped key list and
// sourcing notes.
import type {
  GameruleKey,
  WorldState,
  RunQuickResult,
} from '../../../shared/types/world-controls';
export type { GameruleKey, WorldState, RunQuickResult };

export interface QuickActionCmd {
  cmd: string[];
  label: string;
}
export interface QuickActionRule {
  rule: GameruleKey;
  value: 'true' | 'false';
  label: string;
}
export interface QuickActionVariants {
  variants: string[][];
  label: string;
}
export interface QuickActionProp {
  prop: 'pvp';
  value: boolean;
  label: string;
}
export type QuickAction =
  QuickActionCmd | QuickActionRule | QuickActionVariants | QuickActionProp;

export interface TimeInfo {
  ticks: number;
  label: string;
  clock: string;
}
