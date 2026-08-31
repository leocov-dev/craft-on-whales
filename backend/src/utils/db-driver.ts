export type DbDriver = 'sqlite' | 'postgres';

// Single source of truth for parsing DB_DRIVER — called both from
// db/schema/index.ts (module load time, no Nest DI available yet) and
// ConfigService (constructor). Keeping this a plain function rather than a
// service is what lets the schema barrel call it before the DI container
// exists.
export function resolveDbDriver(
  env: NodeJS.ProcessEnv = process.env,
): DbDriver {
  const raw = (env.DB_DRIVER || 'sqlite').trim();
  if (raw === 'sqlite' || raw === 'postgres') return raw;
  throw new Error(`DB_DRIVER must be "sqlite" or "postgres" — got "${raw}".`);
}
