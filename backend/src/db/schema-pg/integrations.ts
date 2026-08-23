// Postgres mirror of ../schema/integrations.ts — see ./PG_SCHEMA_NOTES.md.

import { sql } from 'drizzle-orm';
import { pgTable, text, boolean, primaryKey } from 'drizzle-orm/pg-core';

export const integrations = pgTable(
  'integrations',
  {
    serverId: text('server_id').notNull(),
    kind: text('kind').notNull(), // 'discord-webhook' | 'discord-bot' | 'status-page'
    enabled: boolean('enabled').notNull().default(false),
    configCipher: text('config_cipher'),
    configJson: text('config_json').notNull().default('{}'),
    updatedAt: text('updated_at').notNull().default(sql`now()::text`),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.kind] })]
);
