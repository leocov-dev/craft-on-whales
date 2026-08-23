import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { servers } from './servers';

export const blueprints = sqliteTable('blueprints', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  filename: text('filename').notNull(),
  relPath: text('rel_path').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
  manifestJson: text('manifest_json').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const backups = sqliteTable(
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
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => [index('idx_backups_server').on(t.serverId, t.createdAt)]
);
