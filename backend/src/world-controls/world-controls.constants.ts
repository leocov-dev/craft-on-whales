import type { GameruleKey, QuickAction } from './world-controls.types';

export const GAMERULES: Record<GameruleKey, string> = {
  keepInventory: 'keep_inventory',
  doDaylightCycle: 'do_daylight_cycle',
  doWeatherCycle: 'do_weather_cycle',
  mobGriefing: 'mob_griefing',
  doMobSpawning: 'do_mob_spawning',
  doFireTick: 'do_fire_tick',
  fallDamage: 'fall_damage',
  naturalRegeneration: 'natural_regeneration',
  doInsomnia: 'do_insomnia',
  doImmediateRespawn: 'do_immediate_respawn',
};

export const QUICK_ACTIONS: Record<string, QuickAction> = {
  'time-day': { cmd: ['time', 'set', 'day'], label: 'Time set to day' },
  'time-noon': { cmd: ['time', 'set', 'noon'], label: 'Time set to noon' },
  'time-night': { cmd: ['time', 'set', 'night'], label: 'Time set to night' },
  'time-midnight': { cmd: ['time', 'set', 'midnight'], label: 'Time set to midnight' },
  'weather-clear': { cmd: ['weather', 'clear'], label: 'Weather cleared' },
  'weather-rain': { cmd: ['weather', 'rain'], label: 'Rain started' },
  'weather-thunder': { cmd: ['weather', 'thunder'], label: 'Thunderstorm started' },
  'keepinv-on': { rule: 'keepInventory', value: 'true', label: 'Keep inventory ON' },
  'keepinv-off': { rule: 'keepInventory', value: 'false', label: 'Keep inventory OFF' },
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
  'weathercycle-on': { rule: 'doWeatherCycle', value: 'true', label: 'Weather cycle ON' },
  'weathercycle-off': { rule: 'doWeatherCycle', value: 'false', label: 'Weather cycle FROZEN' },
  'mobgrief-on': { rule: 'mobGriefing', value: 'true', label: 'Mob griefing ON' },
  'mobgrief-off': { rule: 'mobGriefing', value: 'false', label: 'Mob griefing OFF (no creeper holes)' },
  'mobspawn-on': { rule: 'doMobSpawning', value: 'true', label: 'Mob spawning ON' },
  'mobspawn-off': { rule: 'doMobSpawning', value: 'false', label: 'Mob spawning OFF' },
  'firetick-on': { rule: 'doFireTick', value: 'true', label: 'Fire spread ON' },
  'firetick-off': { rule: 'doFireTick', value: 'false', label: 'Fire spread OFF' },
  'falldmg-on': { rule: 'fallDamage', value: 'true', label: 'Fall damage ON' },
  'falldmg-off': { rule: 'fallDamage', value: 'false', label: 'Fall damage OFF' },
  'naturalregen-on': { rule: 'naturalRegeneration', value: 'true', label: 'Natural regen ON' },
  'naturalregen-off': { rule: 'naturalRegeneration', value: 'false', label: 'Natural regen OFF' },
  'phantoms-on': { rule: 'doInsomnia', value: 'true', label: 'Phantoms ON' },
  'phantoms-off': { rule: 'doInsomnia', value: 'false', label: 'Phantoms OFF (no insomnia)' },
  'instantrespawn-on': { rule: 'doImmediateRespawn', value: 'true', label: 'Instant respawn ON' },
  'instantrespawn-off': { rule: 'doImmediateRespawn', value: 'false', label: 'Instant respawn OFF' },
  // PvP has no gamerule — it's the server.properties `pvp` value (see below).
  'pvp-on': { prop: 'pvp', value: true, label: 'PvP enabled — applies on restart' },
  'pvp-off': { prop: 'pvp', value: false, label: 'PvP disabled — applies on restart' },
  'difficulty-peaceful': { cmd: ['difficulty', 'peaceful'], label: 'Difficulty: Peaceful' },
  'difficulty-easy': { cmd: ['difficulty', 'easy'], label: 'Difficulty: Easy' },
  'difficulty-normal': { cmd: ['difficulty', 'normal'], label: 'Difficulty: Normal' },
  'difficulty-hard': { cmd: ['difficulty', 'hard'], label: 'Difficulty: Hard' },
  'save-all': { cmd: ['save-all', 'flush'], label: 'World saved' },
};
