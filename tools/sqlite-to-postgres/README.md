# SQLite → Postgres cutover

A one-shot tool for moving an existing panel install from SQLite to Postgres.
It copies every row from your `panel.db` file into a Postgres database — it
never modifies or deletes the SQLite file, so you can always go back to it if
something looks wrong (switching back to SQLite afterwards isn't supported by
the panel itself, but the file stays exactly as it was).

## When to use this

Only after you've already:

1. Set `DB_DRIVER=postgres` and `DATABASE_URL=...` in the panel's environment.
2. Started the panel once against that Postgres database, so its schema
   exists (empty tables, no data yet).

This tool then copies your old SQLite data into that empty schema.

## Running it

No install needed — run it directly from GitHub:

```
npx github:leocov-dev/craft-on-whales#path:tools/sqlite-to-postgres -- \
  --sqlite-file /path/to/data/panel.db \
  --database-url postgres://user:pass@host:5432/panel
```

Add `--yes` to skip the confirmation prompt (useful in a script).

## What it checks

- The Postgres target must already be migrated (it looks for the schema's
  migration-tracking table) — if not, it tells you to start the panel against
  Postgres first.
- Every target table must be empty. This is a one-shot cutover, not a merge —
  if the target already has data, it refuses to run rather than guess.

If either check fails, nothing is written.
