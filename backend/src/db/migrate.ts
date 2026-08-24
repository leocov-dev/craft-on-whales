import * as path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate as migrateSqlite } from 'drizzle-orm/node-sqlite/migrator';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { DbService } from './db.service';

const MIGRATIONS_FOLDER = path.resolve(__dirname, '..', '..', 'drizzle');
const PG_MIGRATIONS_FOLDER = path.resolve(__dirname, '..', '..', 'drizzle-pg');
const MIGRATIONS_TABLE = '__drizzle_migrations';

// Invoked explicitly from main.ts's bootstrap sequence, not from the DI
// graph — migrations must run before any request-handling code touches db.
export async function runMigrations(dbService: DbService): Promise<void> {
  // Postgres installs are always new (there's no legacy pre-Drizzle Postgres
  // install to adopt), so none of the SQLite baseline logic below applies —
  // just run drizzle's migrator straight against its own migrations folder.
  if (dbService.driver === 'postgres') {
    // dbService.db is typed as the SQLite drizzle shape unconditionally
    // (see schema/DUAL_DIALECT_NOTES.md) but is genuinely a NodePgDatabase
    // at runtime here — cast back to call the Postgres migrator.
    await migratePg(
      dbService.db as unknown as Parameters<typeof migratePg>[0],
      { migrationsFolder: PG_MIGRATIONS_FOLDER },
    );
    return;
  }

  const db = dbService.db;

  const migrationsTableExists =
    db.all(
      sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${MIGRATIONS_TABLE}`,
    ).length > 0;

  // The "copy $DATA_DIR to migrate the panel" guarantee: an existing install's
  // data dir has a `servers` table (created by the LEGACY hand-written
  // migration runner, tracked in its own `schema_migrations` table Drizzle
  // has never heard of) but no `__drizzle_migrations` bookkeeping table yet.
  // Calling drizzle-orm's migrate() unmodified in that case is a real bug,
  // not a hypothetical: it sees an empty/missing migrations table, assumes a
  // brand-new DB, and tries to CREATE TABLE everything from scratch —
  // colliding with tables that already exist and crashing the boot.
  // Verified against a real legacy-created DB during the Phase 2 cutover
  // (see the plan's cutover checklist item 5) before this fix existed.
  //
  // Fix: if the migrations table doesn't exist yet AND the schema already
  // exists (checked via the `servers` table, present from the very first
  // legacy migration onward), this is an upgrade of an existing install —
  // baseline every current migration as already-applied without running
  // their SQL, since the schema-verification pass earlier in this project
  // confirmed the generated Drizzle schema reproduces the legacy schema
  // exactly (column-for-column, via a real PRAGMA table_info() diff against
  // a freshly-migrated legacy DB — see DRIZZLE_NOTES.md). A genuinely fresh
  // install (no `servers` table either) falls through to a normal migrate().
  if (!migrationsTableExists) {
    const preexistingSchema =
      db.all(
        sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'servers'`,
      ).length > 0;
    if (preexistingSchema) {
      baselineExistingSchema(dbService);
      return;
    }
  }

  migrateSqlite(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

function baselineExistingSchema(dbService: DbService): void {
  const db = dbService.db;
  const migrations = readMigrationFiles({
    migrationsFolder: MIGRATIONS_FOLDER,
  });

  db.run(sql`
    CREATE TABLE IF NOT EXISTS ${sql.identifier(MIGRATIONS_TABLE)} (
      id INTEGER PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric,
      name text,
      applied_at TEXT
    )
  `);
  const appliedAt = new Date().toISOString();
  for (const m of migrations) {
    db.run(
      sql`INSERT INTO ${sql.identifier(MIGRATIONS_TABLE)} ("hash", "created_at", "name", "applied_at") VALUES (${m.hash}, ${m.folderMillis}, ${m.name}, ${appliedAt})`,
    );
  }

  console.log(
    `[migrate] adopted existing schema — baselined ${migrations.length} migration(s) without re-running them`,
  );
}
