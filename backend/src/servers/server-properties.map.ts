/**
 * server.properties <-> itzg/minecraft-server environment variables.
 *
 * The image rewrites every property it has a matching env var for on *each*
 * container start. So a panel edit to `server.properties` is silently undone
 * on the next restart whenever that property's env var is set — the whole
 * point of `ServerPropertiesService.setServerProperty()`, which clears the
 * env var so the on-disk value wins from then on.
 *
 * Keys the image does not derive from env (or that it derives from something
 * other than a plain 1:1 var) are deliberately absent: an absent key just
 * means "nothing to unlock", which is the safe default.
 */
export const PROPERTY_ENV: Readonly<Record<string, string>> = {
  'allow-flight': 'ALLOW_FLIGHT',
  'allow-nether': 'ALLOW_NETHER',
  'announce-player-achievements': 'ANNOUNCE_PLAYER_ACHIEVEMENTS',
  'broadcast-console-to-ops': 'BROADCAST_CONSOLE_TO_OPS',
  'broadcast-rcon-to-ops': 'BROADCAST_RCON_TO_OPS',
  difficulty: 'DIFFICULTY',
  'enable-command-block': 'ENABLE_COMMAND_BLOCK',
  'enable-jmx-monitoring': 'ENABLE_JMX',
  'enable-query': 'ENABLE_QUERY',
  'enable-status': 'ENABLE_STATUS',
  'enforce-secure-profile': 'ENFORCE_SECURE_PROFILE',
  'enforce-whitelist': 'ENFORCE_WHITELIST',
  'entity-broadcast-range-percentage': 'ENTITY_BROADCAST_RANGE_PERCENTAGE',
  'force-gamemode': 'FORCE_GAMEMODE',
  'function-permission-level': 'FUNCTION_PERMISSION_LEVEL',
  gamemode: 'MODE',
  'generate-structures': 'GENERATE_STRUCTURES',
  'generator-settings': 'GENERATOR_SETTINGS',
  hardcore: 'HARDCORE',
  'hide-online-players': 'HIDE_ONLINE_PLAYERS',
  'initial-disabled-packs': 'INITIAL_DISABLED_PACKS',
  'initial-enabled-packs': 'INITIAL_ENABLED_PACKS',
  'level-name': 'LEVEL',
  'level-seed': 'SEED',
  'level-type': 'LEVEL_TYPE',
  'log-ips': 'LOG_IPS',
  'max-build-height': 'MAX_BUILD_HEIGHT',
  'max-chained-neighbor-updates': 'MAX_CHAINED_NEIGHBOR_UPDATES',
  'max-players': 'MAX_PLAYERS',
  'max-tick-time': 'MAX_TICK_TIME',
  'max-world-size': 'MAX_WORLD_SIZE',
  motd: 'MOTD',
  'network-compression-threshold': 'NETWORK_COMPRESSION_THRESHOLD',
  'online-mode': 'ONLINE_MODE',
  'op-permission-level': 'OP_PERMISSION_LEVEL',
  'pause-when-empty-seconds': 'PAUSE_WHEN_EMPTY_SECONDS',
  'player-idle-timeout': 'PLAYER_IDLE_TIMEOUT',
  'prevent-proxy-connections': 'PREVENT_PROXY_CONNECTIONS',
  pvp: 'PVP',
  'rate-limit': 'RATE_LIMIT',
  'region-file-compression': 'REGION_FILE_COMPRESSION',
  // The image's enforce flag is RESOURCE_PACK_ENFORCE, not REQUIRE_RESOURCE_PACK.
  'require-resource-pack': 'RESOURCE_PACK_ENFORCE',
  'resource-pack': 'RESOURCE_PACK',
  'resource-pack-prompt': 'RESOURCE_PACK_PROMPT',
  'resource-pack-sha1': 'RESOURCE_PACK_SHA1',
  'simulation-distance': 'SIMULATION_DISTANCE',
  'snooper-enabled': 'SNOOPER_ENABLED',
  'spawn-animals': 'SPAWN_ANIMALS',
  'spawn-monsters': 'SPAWN_MONSTERS',
  'spawn-npcs': 'SPAWN_NPCS',
  'spawn-protection': 'SPAWN_PROTECTION',
  'sync-chunk-writes': 'SYNC_CHUNK_WRITES',
  'text-filtering-config': 'TEXT_FILTERING_CONFIG',
  'use-native-transport': 'USE_NATIVE_TRANSPORT',
  'view-distance': 'VIEW_DISTANCE',
  'white-list': 'ENABLE_WHITELIST',
};

/**
 * Env vars `ServerEnvironmentService.assembleEnv()` owns outright. Clearing
 * one of these from `env_json` would achieve nothing (assembleEnv puts it
 * straight back) and, for the RCON trio, would break panel management if it
 * ever did stick — so a property edit never unlocks them.
 */
export const PANEL_OWNED_ENV: ReadonlySet<string> = new Set([
  'EULA',
  'TYPE',
  'VERSION',
  'MEMORY',
  'ENABLE_RCON',
  'RCON_PASSWORD',
  'RCON_PORT',
  'SERVER_PORT',
  'STOP_DURATION',
  'TZ',
  'UID',
  'GID',
]);

/** The env var backing a property, or null when there is nothing to unlock. */
export function envVarForProperty(key: string): string | null {
  const envVar = PROPERTY_ENV[key];
  if (!envVar || PANEL_OWNED_ENV.has(envVar)) return null;
  return envVar;
}
