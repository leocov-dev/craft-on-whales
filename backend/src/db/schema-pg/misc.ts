// Postgres mirror of ../schema/misc.ts — see ./PG_SCHEMA_NOTES.md.
//
// Small standalone tables: panel settings, cached third-party API responses,
// encrypted API keys, background storage-indexer state, and outdated-content
// tracking. Grouped here rather than one file each since none of them have
// enough surface area (or relations to each other) to warrant a split.

import { sql } from 'drizzle-orm';
import { pgTable, text, integer, serial, boolean, primaryKey } from 'drizzle-orm/pg-core';

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
});

export const apiKeys = pgTable('api_keys', {
  provider: text('provider').primaryKey(), // 'curseforge', ...
  keyCipher: text('key_cipher').notNull(), // AES-256-GCM: iv:tag:ciphertext (base64)
  addedAt: text('added_at').notNull().default(sql`now()::text`),
  lastTestedAt: text('last_tested_at'),
  lastTestOk: boolean('last_test_ok'),
});

export const apiCache = pgTable('api_cache', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  fetchedAt: text('fetched_at').notNull().default(sql`now()::text`),
});

export const storageIndex = pgTable('storage_index', {
  relPath: text('rel_path').primaryKey(), // directory path under DATA_DIR
  sizeBytes: integer('size_bytes').notNull(),
  fileCount: integer('file_count').notNull(),
  scannedAt: text('scanned_at').notNull().default(sql`now()::text`),
});

export const storageSnapshots = pgTable('storage_snapshots', {
  id: serial('id').primaryKey(),
  totalBytes: integer('total_bytes').notNull(),
  perServerJson: text('per_server_json').notNull().default('{}'),
  createdAt: text('created_at').notNull().default(sql`now()::text`),
});

export const updateChecks = pgTable(
  'update_checks',
  {
    subjectType: text('subject_type').notNull(), // 'pack' | 'content' | 'image'
    subjectId: text('subject_id').notNull(), // server_id | server_content.id | image tag
    currentVersion: text('current_version').notNull(),
    latestVersion: text('latest_version'),
    latestName: text('latest_name'),
    changelogUrl: text('changelog_url'),
    checkedAt: text('checked_at').notNull().default(sql`now()::text`),
  },
  (t) => [primaryKey({ columns: [t.subjectType, t.subjectId] })]
);
