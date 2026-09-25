// Every vanilla *boolean* gamerule (see GAMERULES in world-controls.constants.ts
// for sourcing/scope notes). Numeric gamerules (randomTickSpeed, spawnRadius,
// etc.) are out of scope for this table.
export type GameruleKey =
  // World rules
  | 'keepInventory'
  | 'doDaylightCycle'
  | 'doWeatherCycle'
  | 'doImmediateRespawn'
  | 'doLimitedCrafting'
  | 'doTileDrops'
  | 'doEntityDrops'
  | 'doFireTick'
  | 'allowFireTicksAwayFromPlayer'
  | 'doVinesSpread'
  | 'waterSourceConversion'
  | 'lavaSourceConversion'
  | 'tntExplodes'
  | 'projectilesCanBreakBlocks'
  | 'blockExplosionDropDecay'
  | 'mobExplosionDropDecay'
  | 'tntExplosionDropDecay'
  | 'enderPearlsVanishOnDeath'
  | 'globalSoundEvents'
  | 'spectatorsGenerateChunks'
  | 'reducedDebugInfo'
  | 'disableElytraMovementCheck'
  | 'locatorBar'
  // Mobs & damage
  | 'doMobSpawning'
  | 'mobGriefing'
  | 'doInsomnia'
  | 'doMobLoot'
  | 'doPatrolSpawning'
  | 'doTraderSpawning'
  | 'doWardenSpawning'
  | 'disableRaids'
  | 'forgiveDeadPlayers'
  | 'universalAnger'
  | 'naturalRegeneration'
  | 'fallDamage'
  | 'fireDamage'
  | 'drowningDamage'
  | 'freezeDamage'
  // Chat & messages
  | 'showDeathMessages'
  | 'announceAdvancements'
  | 'sendCommandFeedback'
  | 'commandBlockOutput'
  | 'logAdminCommands';

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
