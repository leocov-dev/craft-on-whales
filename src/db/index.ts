'use strict';

// SQLite via Node's built-in node:sqlite (synchronous, zero native deps).
// This thin wrapper is the only module that touches the driver, so swapping
// to libsql/better-sqlite3 later means changing this file alone.

import type { SQLInputValue, StatementResultingChanges } from 'node:sqlite';
import type { Db, Row } from './types';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
const config = require('../config');

let db: InstanceType<typeof DatabaseSync> | null = null;

function open(): InstanceType<typeof DatabaseSync> {
  if (db) return db;
  db = new DatabaseSync(path.join(config.dataDir, 'panel.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** Prepared-statement helpers. All synchronous — node:sqlite mirrors better-sqlite3. */
function run(sql: string, ...params: SQLInputValue[]): StatementResultingChanges {
  return open()
    .prepare(sql)
    .run(...params);
}
function get(sql: string, ...params: SQLInputValue[]): Row | undefined {
  return open()
    .prepare(sql)
    .get(...params);
}
function all(sql: string, ...params: SQLInputValue[]): Row[] {
  return open()
    .prepare(sql)
    .all(...params);
}
function exec(sql: string): void {
  return open().exec(sql);
}

/** Run `fn` inside a transaction; rolls back on throw. */
function transaction<T>(fn: () => T): T {
  const d = open();
  d.exec('BEGIN');
  try {
    const result = fn();
    d.exec('COMMIT');
    return result;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

function close(): void {
  if (db) {
    db.close();
    db = null;
  }
}

const dbApi: Db = { open, run, get, all, exec, transaction, close };

export = dbApi;
