import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
} from 'drizzle-orm/sqlite-core';

export const integrations = sqliteTable(
  'integrations',
  {
    serverId: text('server_id').notNull(),
    kind: text('kind').notNull(), // 'discord-webhook' | 'discord-bot' | 'status-page'
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
    configCipher: text('config_cipher'),
    configJson: text('config_json').notNull().default('{}'),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.kind] })],
);
