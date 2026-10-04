import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Stand-in `pg_dump` / `pg_restore` shell scripts, so the dump pipeline is
 * exercised without a Postgres server. The dump writes a marker file and logs
 * the PG* environment it was given; the restore accepts only that marker.
 */
export function fakePgTools(
  dir: string,
  { dumpFails = false, restoreFails = false } = {},
): { dump: string; restore: string; log: string } {
  const log = path.join(dir, 'pg-env.log');
  const dump = path.join(dir, 'fake-pg_dump');
  const restore = path.join(dir, 'fake-pg_restore');
  fs.writeFileSync(
    dump,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 17.0"; exit 0; fi
${dumpFails ? 'echo "connection refused" >&2; exit 1' : ''}
env | grep -E '^(PG|SESSION|SECRET)' | sort > '${log}'
echo "$@" >> '${log}'
while [ $# -gt 0 ]; do
  if [ "$1" = "--file" ]; then printf PGDUMP > "$2"; fi
  shift
done
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    restore,
    `#!/bin/sh
${restoreFails ? 'echo "not a pg_dump archive" >&2; exit 1' : ''}
[ "$(cat "$2")" = "PGDUMP" ] || { echo "bad archive" >&2; exit 1; }
`,
    { mode: 0o755 },
  );
  return { dump, restore, log };
}
