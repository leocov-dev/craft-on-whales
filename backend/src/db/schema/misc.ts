// Small standalone tables: panel settings, cached third-party API responses,
// encrypted API keys, background storage-indexer state, and outdated-content
// tracking. Grouped here rather than one file each since none of them have
// enough surface area (or relations to each other) to warrant a split.

import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
} from 'drizzle-orm/sqlite-core';

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
});

export const apiKeys = sqliteTable('api_keys', {
  provider: text('provider').primaryKey(), // 'curseforge', ...
  keyCipher: text('key_cipher').notNull(), // AES-256-GCM: iv:tag:ciphertext (base64)
  addedAt: text('added_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  lastTestedAt: text('last_tested_at'),
  lastTestOk: integer('last_test_ok', { mode: 'boolean' }),
});

export const apiCache = sqliteTable('api_cache', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  fetchedAt: text('fetched_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const storageIndex = sqliteTable('storage_index', {
  relPath: text('rel_path').primaryKey(), // directory path under DATA_DIR
  sizeBytes: integer('size_bytes').notNull(),
  fileCount: integer('file_count').notNull(),
  scannedAt: text('scanned_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const storageSnapshots = sqliteTable('storage_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  totalBytes: integer('total_bytes').notNull(),
  perServerJson: text('per_server_json').notNull().default('{}'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const updateChecks = sqliteTable(
  'update_checks',
  {
    subjectType: text('subject_type').notNull(), // 'pack' | 'content' | 'image'
    subjectId: text('subject_id').notNull(), // server_id | server_content.id | image tag
    currentVersion: text('current_version').notNull(),
    latestVersion: text('latest_version'),
    latestName: text('latest_name'),
    changelogUrl: text('changelog_url'),
    checkedAt: text('checked_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [primaryKey({ columns: [t.subjectType, t.subjectId] })],
);
