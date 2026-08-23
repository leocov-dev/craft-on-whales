export type GameruleKey =
  | 'keepInventory'
  | 'doDaylightCycle'
  | 'doWeatherCycle'
  | 'mobGriefing'
  | 'doMobSpawning'
  | 'doFireTick'
  | 'fallDamage'
  | 'naturalRegeneration'
  | 'doInsomnia'
  | 'doImmediateRespawn';

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
export type QuickAction = QuickActionCmd | QuickActionRule | QuickActionVariants | QuickActionProp;

export interface TimeInfo {
  ticks: number;
  label: string;
  clock: string;
}

export interface WorldState {
  timeTicks?: number;
  timeLabel?: string;
  clock?: string;
  day?: number | null;
  pvp: boolean;
  [rule: string]: boolean | number | string | null | undefined;
}

export interface RunQuickResult {
  label: string;
  output: string;
}
