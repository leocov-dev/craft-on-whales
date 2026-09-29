// Cross-boundary shapes for `GET/POST /api/servers/:id/world/*`
// (backend/src/world-controls/). Source of truth for `GameruleKey` and
// `WorldState` — the backend re-exports both from here (see
// world-controls.types.ts) instead of defining them locally, so the
// frontend's gamerule toggle table (WorldControlsTab.vue) never has to
// hand-duplicate the 43-key union.

// Every vanilla *boolean* gamerule (see GAMERULES in
// backend/src/world-controls/world-controls.constants.ts for sourcing/scope
// notes). Numeric gamerules (randomTickSpeed, spawnRadius, etc.) are out of
// scope for this table.
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

/** `GET /api/servers/:id/world/state`'s `state` field. A gamerule key is
 * absent (not `false`) when the server doesn't recognize it on this MC
 * version — that's distinct from the rule being explicitly turned off. */
export interface WorldState {
  timeTicks?: number;
  timeLabel?: string;
  clock?: string;
  day?: number | null;
  pvp: boolean;
  [rule: string]: boolean | number | string | null | undefined;
}

/** `POST /api/servers/:id/world/quick`'s response, spread onto `{ ok: true }`. */
export interface RunQuickResult {
  label: string;
  output: string;
}
