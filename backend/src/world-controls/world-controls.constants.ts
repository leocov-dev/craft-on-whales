import type { GameruleKey, QuickAction } from './world-controls.types';

// Full vanilla *boolean* gamerule set (numeric ones like randomTickSpeed,
// spawnRadius, maxCommandChainLength, snowAccumulationHeight, etc. are out of
// scope here — this table only backs boolean on/off reads). camelCase key ->
// MC 26.x's snake_case rename (see world-controls.service.ts's queryGamerule/
// setGamerule, which already try both spellings for every entry — adding a
// rule here needs no other code change).
//
// Sourced from the vanilla gamerule list as of a recent MC version, cross-checked
// against upstream's own full-coverage pass (different stack, same product —
// see UPSTREAM_PARITY.md item 3.24) plus the wiki's current gamerule table.
// `locatorBar` was added on top of upstream's list — it's a boolean gamerule
// upstream's pass didn't have yet.
export const GAMERULES: Record<GameruleKey, string> = {
  // World rules
  keepInventory: 'keep_inventory',
  doDaylightCycle: 'do_daylight_cycle',
  doWeatherCycle: 'do_weather_cycle',
  doImmediateRespawn: 'do_immediate_respawn',
  doLimitedCrafting: 'do_limited_crafting',
  doTileDrops: 'do_tile_drops',
  doEntityDrops: 'do_entity_drops',
  doFireTick: 'do_fire_tick',
  allowFireTicksAwayFromPlayer: 'allow_fire_ticks_away_from_player',
  doVinesSpread: 'do_vines_spread',
  waterSourceConversion: 'water_source_conversion',
  lavaSourceConversion: 'lava_source_conversion',
  tntExplodes: 'tnt_explodes',
  projectilesCanBreakBlocks: 'projectiles_can_break_blocks',
  blockExplosionDropDecay: 'block_explosion_drop_decay',
  mobExplosionDropDecay: 'mob_explosion_drop_decay',
  tntExplosionDropDecay: 'tnt_explosion_drop_decay',
  enderPearlsVanishOnDeath: 'ender_pearls_vanish_on_death',
  globalSoundEvents: 'global_sound_events',
  spectatorsGenerateChunks: 'spectators_generate_chunks',
  reducedDebugInfo: 'reduced_debug_info',
  disableElytraMovementCheck: 'disable_elytra_movement_check',
  locatorBar: 'locator_bar',
  // Mobs & damage
  doMobSpawning: 'do_mob_spawning',
  mobGriefing: 'mob_griefing',
  doInsomnia: 'do_insomnia',
  doMobLoot: 'do_mob_loot',
  doPatrolSpawning: 'do_patrol_spawning',
  doTraderSpawning: 'do_trader_spawning',
  doWardenSpawning: 'do_warden_spawning',
  disableRaids: 'disable_raids',
  forgiveDeadPlayers: 'forgive_dead_players',
  universalAnger: 'universal_anger',
  naturalRegeneration: 'natural_regeneration',
  fallDamage: 'fall_damage',
  fireDamage: 'fire_damage',
  drowningDamage: 'drowning_damage',
  freezeDamage: 'freeze_damage',
  // Chat & messages
  showDeathMessages: 'show_death_messages',
  announceAdvancements: 'announce_advancements',
  sendCommandFeedback: 'send_command_feedback',
  commandBlockOutput: 'command_block_output',
  logAdminCommands: 'log_admin_commands',
};

export const QUICK_ACTIONS: Record<string, QuickAction> = {
  'time-day': { cmd: ['time', 'set', 'day'], label: 'Time set to day' },
  'time-noon': { cmd: ['time', 'set', 'noon'], label: 'Time set to noon' },
  'time-night': { cmd: ['time', 'set', 'night'], label: 'Time set to night' },
  'time-midnight': {
    cmd: ['time', 'set', 'midnight'],
    label: 'Time set to midnight',
  },
  'weather-clear': { cmd: ['weather', 'clear'], label: 'Weather cleared' },
  'weather-rain': { cmd: ['weather', 'rain'], label: 'Rain started' },
  'weather-thunder': {
    cmd: ['weather', 'thunder'],
    label: 'Thunderstorm started',
  },
  'keepinv-on': {
    rule: 'keepInventory',
    value: 'true',
    label: 'Keep inventory ON',
  },
  'keepinv-off': {
    rule: 'keepInventory',
    value: 'false',
    label: 'Keep inventory OFF',
  },
  // 26.x moved the day/night cycle out of gamerules into /time resume|pause.
  'daycycle-on': {
    variants: [
      ['time', 'resume'],
      ['gamerule', 'doDaylightCycle', 'true'],
    ],
    label: 'Day/night cycle ON',
  },
  'daycycle-off': {
    variants: [
      ['time', 'pause'],
      ['gamerule', 'doDaylightCycle', 'false'],
    ],
    label: 'Day/night cycle FROZEN',
  },
  'weathercycle-on': {
    rule: 'doWeatherCycle',
    value: 'true',
    label: 'Weather cycle ON',
  },
  'weathercycle-off': {
    rule: 'doWeatherCycle',
    value: 'false',
    label: 'Weather cycle FROZEN',
  },
  'mobgrief-on': {
    rule: 'mobGriefing',
    value: 'true',
    label: 'Mob griefing ON',
  },
  'mobgrief-off': {
    rule: 'mobGriefing',
    value: 'false',
    label: 'Mob griefing OFF (no creeper holes)',
  },
  'mobspawn-on': {
    rule: 'doMobSpawning',
    value: 'true',
    label: 'Mob spawning ON',
  },
  'mobspawn-off': {
    rule: 'doMobSpawning',
    value: 'false',
    label: 'Mob spawning OFF',
  },
  'firetick-on': { rule: 'doFireTick', value: 'true', label: 'Fire spread ON' },
  'firetick-off': {
    rule: 'doFireTick',
    value: 'false',
    label: 'Fire spread OFF',
  },
  'falldmg-on': { rule: 'fallDamage', value: 'true', label: 'Fall damage ON' },
  'falldmg-off': {
    rule: 'fallDamage',
    value: 'false',
    label: 'Fall damage OFF',
  },
  'naturalregen-on': {
    rule: 'naturalRegeneration',
    value: 'true',
    label: 'Natural regen ON',
  },
  'naturalregen-off': {
    rule: 'naturalRegeneration',
    value: 'false',
    label: 'Natural regen OFF',
  },
  'phantoms-on': { rule: 'doInsomnia', value: 'true', label: 'Phantoms ON' },
  'phantoms-off': {
    rule: 'doInsomnia',
    value: 'false',
    label: 'Phantoms OFF (no insomnia)',
  },
  'instantrespawn-on': {
    rule: 'doImmediateRespawn',
    value: 'true',
    label: 'Instant respawn ON',
  },
  'instantrespawn-off': {
    rule: 'doImmediateRespawn',
    value: 'false',
    label: 'Instant respawn OFF',
  },
  // PvP has no gamerule — it's the server.properties `pvp` value (see below).
  'pvp-on': {
    prop: 'pvp',
    value: true,
    label: 'PvP enabled — applies on restart',
  },
  'pvp-off': {
    prop: 'pvp',
    value: false,
    label: 'PvP disabled — applies on restart',
  },
  'difficulty-peaceful': {
    cmd: ['difficulty', 'peaceful'],
    label: 'Difficulty: Peaceful',
  },
  'difficulty-easy': { cmd: ['difficulty', 'easy'], label: 'Difficulty: Easy' },
  'difficulty-normal': {
    cmd: ['difficulty', 'normal'],
    label: 'Difficulty: Normal',
  },
  'difficulty-hard': { cmd: ['difficulty', 'hard'], label: 'Difficulty: Hard' },
  'save-all': { cmd: ['save-all', 'flush'], label: 'World saved' },
};
