'use strict';

// Shared types for src/db. Extracted to their own file (rather than living in
// index.ts alongside its `export =`) because tsx's esbuild-based CJS loader
// transforms each file independently and can silently drop type-only exports
// mixed into a file that also has a CommonJS `export =` value statement.

import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';

/** A single result row: column name -> SQLite-native value. */
export type Row = Record<string, SQLOutputValue>;

/** Re-exported so consumers don't need to import from 'node:sqlite' directly. */
export type { SQLInputValue, SQLOutputValue };

/**
 * The thin synchronous wrapper this module exports around node:sqlite's
 * DatabaseSync. All migrations and call sites elsewhere in the codebase
 * interact with the database exclusively through this shape.
 */
export interface Db {
  open(): import('node:sqlite').DatabaseSync;
  run(sql: string, ...params: SQLInputValue[]): import('node:sqlite').StatementResultingChanges;
  get(sql: string, ...params: SQLInputValue[]): Row | undefined;
  all(sql: string, ...params: SQLInputValue[]): Row[];
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  close(): void;
}

/**
 * Shape every ./migrations/NNN_name.ts file exports. Migrations only ever
 * move forward (no `down`) — see migrate.ts.
 */
export interface Migration {
  up(db: Db): void;
}
