// Postgres mirror of ../schema/blueprints.ts — see ./PG_SCHEMA_NOTES.md.

import { sql } from 'drizzle-orm';
import { pgTable, text, integer, boolean, index } from 'drizzle-orm/pg-core';
import { servers } from './servers';

export const blueprints = pgTable('blueprints', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  filename: text('filename').notNull(),
  relPath: text('rel_path').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  builtin: boolean('builtin').notNull().default(false),
  manifestJson: text('manifest_json').notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`now()::text`),
});

export const backups = pgTable(
  'backups',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    relPath: text('rel_path').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256'),
    reason: text('reason').notNull(), // 'manual' | 'scheduled' | 'pre-update'
    note: text('note').notNull().default(''),
    createdAt: text('created_at')
      .notNull()
      .default(sql`now()::text`),
  },
  (t) => [index('idx_backups_server').on(t.serverId, t.createdAt)],
);
