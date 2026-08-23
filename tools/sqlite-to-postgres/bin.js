#!/usr/bin/env node
'use strict';

// Copies every row from an existing panel.db (SQLite) into an already-
// migrated, empty Postgres database — the one-shot cutover step described in
// tools/sqlite-to-postgres/README.md. Never modifies or deletes the source
// SQLite file (opened read-only). Designed to run standalone via
//   npx github:leocov-dev/craft-on-whales#path:tools/sqlite-to-postgres -- <args>
// without cloning or building the rest of the repo — plain CommonJS, no
// build step, no dependency on the backend's compiled schema.
//
// Table discovery, dependency order, and boolean-column coercion are all
// derived at runtime from sqlite_master / information_schema rather than
// hardcoded, so this stays correct as the panel's schema evolves — the only
// assumption is that the Postgres target was already migrated by the panel
// itself (DB_DRIVER=postgres) using the SAME version of the app, so its
// tables/columns match the SQLite source 1:1.

const { DatabaseSync } = require('node:sqlite');
const { Client } = require('pg');

function parseArgs(argv) {
  const args = { yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sqlite-file') args.sqliteFile = argv[++i];
    else if (a === '--database-url') args.databaseUrl = argv[++i];
    else if (a === '--yes' || a === '-y') args.yes = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function printUsage() {
  console.log(`Usage: sqlite-to-postgres --sqlite-file <path> --database-url <url> [--yes]

  --sqlite-file   Path to the existing panel.db SQLite file (read-only; never modified or deleted).
  --database-url  Postgres connection string, same shape as the panel's own DATABASE_URL
                  (e.g. postgres://user:pass@host:5432/panel).
  --yes           Skip the confirmation prompt (for scripted/non-interactive use).

Run this AFTER starting the panel at least once with DB_DRIVER=postgres and the target
DATABASE_URL, so the schema already exists there. The target's tables must all be empty —
this is a one-shot cutover, not a merge or sync tool.`);
}

async function confirm(question) {
  const readline = require('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** Postgres data_type -> coercion of a raw SQLite value into what `pg` should bind. */
function coerceForColumn(value, pgDataType) {
  if (value === null || value === undefined) return null;
  if (pgDataType === 'boolean') return value === 1 || value === true;
  return value;
}

/** Topologically sort tables so a row is never inserted before the tables it references. */
function topoSort(tables, fkEdges) {
  const deps = new Map(tables.map((t) => [t, new Set()]));
  for (const { child, parent } of fkEdges) {
    if (child === parent) continue;
    if (deps.has(child) && deps.has(parent)) deps.get(child).add(parent);
  }
  const sorted = [];
  const done = new Set();
  const visiting = new Set();
  function visit(t) {
    if (done.has(t) || visiting.has(t)) return; // cycle guard — no genuine cycles expected
    visiting.add(t);
    for (const dep of deps.get(t) || []) visit(dep);
    visiting.delete(t);
    done.add(t);
    sorted.push(t);
  }
  for (const t of tables) visit(t);
  return sorted;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.sqliteFile || !args.databaseUrl) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  if (!args.yes) {
    const ok = await confirm(
      `This will copy every row from "${args.sqliteFile}" into the Postgres database at the given URL. The source file is never modified. Continue?`
    );
    if (!ok) {
      console.log('Aborted.');
      return;
    }
  }

  // Read-only: the source SQLite file must never be modified or deleted by this tool.
  const sqlite = new DatabaseSync(args.sqliteFile, { readOnly: true });
  const pg = new Client({ connectionString: args.databaseUrl });
  await pg.connect();

  try {
    // drizzle-orm/node-postgres/migrator tracks applied migrations in its own
    // "drizzle" schema (drizzle.__drizzle_migrations), not "public" — unlike
    // the SQLite side, which keeps its bookkeeping table alongside the app's
    // own tables. Confirmed against a real migrated Postgres database.
    const migrationsCheck = await pg.query(`SELECT to_regclass('drizzle.__drizzle_migrations') AS t`);
    if (!migrationsCheck.rows[0].t) {
      throw new Error(
        'The target Postgres database has no drizzle.__drizzle_migrations table — start the panel once with ' +
          'DB_DRIVER=postgres and this DATABASE_URL so the schema is created, then re-run this tool.'
      );
    }

    const sourceTables = sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations'`
      )
      .all()
      .map((r) => r.name);

    if (!sourceTables.length) {
      console.log('No tables found in the source SQLite file — nothing to do.');
      return;
    }

    // Every source table must exist and be empty on the target — this tool is a
    // one-shot cutover, not a merge: an ambiguous partial import is worse than
    // refusing to run.
    //
    // One deliberate, narrow exception: `schedules`. The panel itself seeds 3
    // global default rows (update-check/storage-scan/tmp-clean, server_id
    // NULL) into that table the very first time it boots against ANY fresh
    // database — SQLite or Postgres — before a user ever touches it (see
    // SchedulerService.seedGlobalDefaults). Since "start the panel once
    // against Postgres so the schema exists" is this tool's own documented
    // prerequisite, the target's `schedules` table is never actually empty in
    // the realistic flow — it's not user data, so it's safe to clear before
    // import (the SQLite source's own schedule rows, defaults included,
    // become authoritative). Only rows matching that exact known shape are
    // cleared; anything else in `schedules` still hits the hard-abort below,
    // same as every other table.
    for (const table of sourceTables) {
      const existsRes = await pg.query(`SELECT to_regclass($1) AS t`, [`public.${table}`]);
      if (!existsRes.rows[0].t) {
        throw new Error(
          `Table "${table}" exists in the SQLite source but not in the Postgres target — the two databases ` +
            "don't match this panel's schema. Make sure the target was migrated by the same panel version."
        );
      }
      if (table === 'schedules') {
        const seedCheck = await pg.query(
          `SELECT count(*) FILTER (
             WHERE server_id IS NULL AND task_type IN ('update-check', 'storage-scan', 'tmp-clean')
           )::int AS seeded, count(*)::int AS total
           FROM "schedules"`
        );
        const { seeded, total } = seedCheck.rows[0];
        if (total > 0 && total === seeded) {
          await pg.query(`DELETE FROM "schedules"`);
          console.log(`Cleared ${total} auto-seeded default schedule row(s) from the target (not user data).`);
          continue;
        }
      }
      const countRes = await pg.query(`SELECT count(*)::int AS n FROM "${table}"`);
      if (countRes.rows[0].n > 0) {
        throw new Error(
          `Target table "${table}" already has ${countRes.rows[0].n} row(s) — refusing to import into a non-empty ` +
            'database. This tool only supports a fresh, just-migrated Postgres target.'
        );
      }
    }

    const fkRes = await pg.query(
      `SELECT tc.table_name AS child, ccu.table_name AS parent
       FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = ANY($1)`,
      [sourceTables]
    );
    const importOrder = topoSort(sourceTables, fkRes.rows);

    const columnTypes = {};
    for (const table of sourceTables) {
      const colsRes = await pg.query(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
        [table]
      );
      columnTypes[table] = Object.fromEntries(colsRes.rows.map((r) => [r.column_name, r.data_type]));
    }

    await pg.query('BEGIN');
    const summary = [];
    try {
      for (const table of importOrder) {
        const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all();
        for (const row of rows) {
          const cols = Object.keys(row);
          const colList = cols.map((c) => `"${c}"`).join(', ');
          const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
          const values = cols.map((c) => coerceForColumn(row[c], columnTypes[table][c]));
          await pg.query(`INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`, values);
        }
        summary.push({ table, rows: rows.length });
      }
      await pg.query('COMMIT');
    } catch (err) {
      await pg.query('ROLLBACK');
      throw err;
    }

    console.log('Import complete — the source SQLite file was not modified:');
    for (const s of summary) console.log(`  ${s.table}: ${s.rows} row(s)`);
  } finally {
    sqlite.close();
    await pg.end();
  }
}

main().catch((err) => {
  console.error(`sqlite-to-postgres failed: ${err.message}`);
  process.exit(1);
});
