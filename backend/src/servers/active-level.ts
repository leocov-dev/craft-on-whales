/**
 * Active level name: the `LEVEL` env var wins, then server.properties
 * `level-name`, then `world`. `getProp` is only called when env has no LEVEL.
 * The one place this precedence lives; callers add their own validation.
 */
export function resolveActiveLevel(
  env: Record<string, string> | null | undefined,
  getProp: (key: string) => string | undefined,
): string {
  return env?.LEVEL || getProp('level-name') || 'world';
}
