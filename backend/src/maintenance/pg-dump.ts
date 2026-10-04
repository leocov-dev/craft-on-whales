import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** A dump of a panel-sized database finishes in seconds; this is a runaway guard. */
const DUMP_TIMEOUT_MS = 10 * 60_000;
const STDERR_LIMIT = 1000;

/** Connection-string query parameters libpq has an environment variable for. */
const QUERY_TO_ENV: Record<string, string> = {
  sslmode: 'PGSSLMODE',
  sslrootcert: 'PGSSLROOTCERT',
  sslcert: 'PGSSLCERT',
  sslkey: 'PGSSLKEY',
  connect_timeout: 'PGCONNECT_TIMEOUT',
  host: 'PGHOST', // a unix-socket directory, e.g. ?host=/var/run/postgresql
};

/**
 * `DATABASE_URL` as the PG* environment variables libpq reads. The URL is never
 * passed on the command line: arguments are visible to every user on the host
 * through `ps`, and it carries the password.
 */
export function pgEnvFromUrl(databaseUrl: string): Record<string, string> {
  const url = new URL(databaseUrl);
  const env: Record<string, string> = {};
  if (url.hostname) env.PGHOST = decodeURIComponent(url.hostname);
  if (url.port) env.PGPORT = url.port;
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (database) env.PGDATABASE = database;
  for (const [param, name] of Object.entries(QUERY_TO_ENV)) {
    const value = url.searchParams.get(param);
    if (value) env[name] = value;
  }
  return env;
}

/** A missing client binary, as opposed to the tool running and failing. */
export class PgToolMissingError extends Error {
  constructor(readonly tool: string) {
    super(
      `${tool} was not found. The official image includes it; on a bare install, add the PostgreSQL client tools (postgresql-client) or back the database up yourself.`,
    );
  }
}

async function run(
  bin: string,
  args: string[],
  env: Record<string, string>,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(bin, args, {
      // Not process.env: the panel's own secrets stay out of the child.
      env: { PATH: process.env.PATH ?? '', ...env },
      timeout: DUMP_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') throw new PgToolMissingError(bin);
    const detail = (e.stderr || e.message || '').trim().slice(0, STDERR_LIMIT);
    throw new Error(`${bin} failed: ${detail}`);
  }
}

/**
 * Dump the database to `dest` in pg_dump's custom format (compressed,
 * restorable with `pg_restore`), then list the archive's table of contents
 * as a cheap check that the file is a valid dump.
 */
export async function pgDump(
  { dump, restore }: { dump: string; restore: string },
  env: Record<string, string>,
  dest: string,
): Promise<void> {
  await run(
    dump,
    ['--format=custom', '--no-owner', '--no-privileges', '--file', dest],
    env,
  );
  await run(restore, ['--list', dest], env);
}

/** `pg_dump (PostgreSQL) 17.2`-style version text, or null when not installed. */
export async function pgDumpVersion(bin: string): Promise<string | null> {
  try {
    return (await run(bin, ['--version'], {})).trim();
  } catch (err) {
    if (err instanceof PgToolMissingError) return null;
    throw err;
  }
}
