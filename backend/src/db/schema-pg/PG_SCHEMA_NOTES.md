# Postgres schema translation notes

This directory mirrors `src/db/schema/*.ts` (SQLite) 1:1, table-for-table
and column-for-column, but built with `drizzle-orm/pg-core`. Drizzle's
column builders are dialect-specific (`sqlite-core` vs `pg-core`), so this
isn't a config toggle on one schema — it's a second schema tree that must be
kept in sync by hand whenever the SQLite one changes.

Translation rules applied uniformly when porting a column:

1. `integer(col, { mode: 'boolean' })` (SQLite: 0/1 stored as an integer) →
   `boolean(col)` (Postgres: a native boolean type). This is the one real
   type-level difference between the two trees. The `tools/sqlite-to-postgres`
   cutover script coerces SQLite's `0`/`1` to `true`/`false` on the way in
   by checking each target column's Postgres type at import time — it does
   NOT rely on this file, so don't skip updating both when adding a new
   boolean column.
2. `text(col).default(sql\`(datetime('now'))\`)` → `text(col).default(sql\`now()::text\`)`.
   Timestamps stay `text` columns on the Postgres side too (not a native
   `timestamp` type) — application code already treats these as opaque
   ISO-ish strings, so this avoids any parsing/timezone translation risk.
3. `integer('id').primaryKey({ autoIncrement: true })` → `serial('id').primaryKey()`.
4. Everything else (`text`, `integer`, `real`, `.primaryKey()`, `.notNull()`,
   `.default(...)`, `.references(...)`, `uniqueIndex(...)`, `index(...)`,
   `primaryKey({ columns: [...] })`) has a direct `pg-core` equivalent with
   the same call shape.
5. The SQLite side's `COLLATE NOCASE` gap on `users.username` (see
   `../DRIZZLE_NOTES.md`) has no equivalent applied here either — same known
   limitation on both sides, not reproduced or fixed by this port.

When you change a table in `schema/`, make the matching change here in the
same commit.
