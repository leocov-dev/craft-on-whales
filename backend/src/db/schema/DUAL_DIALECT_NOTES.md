# Why `schema/index.ts` is a runtime dispatcher, not a plain barrel

Every DB-consuming file in the app (~46 of them) imports table objects
straight from `'../db/schema'` (or a relative variant) and calls them
against `DbService.db`, e.g. `db.select().from(schema.servers)`. Drizzle's
query builder types are dialect-specific — a `sqlite-core` `SQLiteTable`
and a `pg-core` `PgTable` are different classes, and `NodePgDatabase` /
`SQLiteDatabase` have incompatible call signatures. Making `DbService.db`
a `SqliteDb | PgDb` union (the "obvious" approach) breaks type inference
across every one of those ~46 files — TypeScript can't call a method that
only half-overlaps between two unrelated overload sets.

Rewriting all 46 files to pick the right schema module per-request isn't
right either — the driver is chosen once at process startup (`DB_DRIVER`),
never per-request, so there's no need for consumers to branch on it at all.

**The fix**: `schema/index.ts` re-exports each table constant from
whichever real module matches `DB_DRIVER` at process start — `./sqlite.ts`
(the actual `sqlite-core` tables, unchanged from before this file existed)
or `../schema-pg` (the actual `pg-core` tables) — cast to the SQLite
module's type. `DbService.db` is typed as the SQLite drizzle type
unconditionally, with the same cast applied to the Postgres client.

This means: **the TypeScript types app code sees are always the SQLite
ones**, but at runtime, when `DB_DRIVER=postgres`, both the query client
(`DbService.db`) and the table objects it's called with
(`schema.servers`, etc.) are genuinely real, matching `pg-core` /
`node-postgres` instances — the cast only fools the compiler, not the
runtime. There is no cross-dialect mixing actually happening (which
Drizzle does not support and often guards against at runtime) — each
process only ever touches one dialect's real objects end-to-end.

**Maintenance rule**: every table exported from `schema/sqlite.ts` (or a
new one added there) must have a same-named counterpart in `schema-pg/`
AND a re-export line added to `schema/index.ts`'s dispatcher — a missing
line means Postgres mode silently falls back to a `sqlite.ts` export
being used with a Postgres client, which is exactly the unsupported
cross-dialect mixing this design avoids. There's no compiler check for
this (the cast defeats it) — the SQLite→Postgres cutover test in
`tools/sqlite-to-postgres` and a manual Postgres boot are what actually
catch a missed table.
