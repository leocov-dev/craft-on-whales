'use strict';

// Tiny versioned migration runner. Migrations live in ./migrations as
// NNN_name.ts files exporting { up(db) }. Applied in filename order inside a
// transaction; applied versions recorded in schema_migrations.

import type { Db, Migration } from './types';

const fs = require('node:fs');
const path = require('node:path');
const { dbApi: db }: { dbApi: Db } = require('./index');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function migrate(): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(db.all('SELECT version FROM schema_migrations').map((r) => r.version));
  const files: string[] = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f: string) => /^\d{3}_.+\.[jt]s$/.test(f))
    .sort();

  let count = 0;
  for (const file of files) {
    const version = file.replace(/\.[jt]s$/, '');
    if (applied.has(version)) continue;
    const { up }: Migration = require(path.join(MIGRATIONS_DIR, file));
    db.transaction(() => {
      up(db);
      db.run('INSERT INTO schema_migrations (version) VALUES (?)', version);
    });
    count += 1;
    console.log(`[db] applied migration ${version}`);
  }
  return count;
}

export { migrate };
