// Postgres mirror of ../schema/schedules.ts — see ./PG_SCHEMA_NOTES.md.

import { sql } from 'drizzle-orm';
import { pgTable, text, boolean } from 'drizzle-orm/pg-core';
import { servers } from './servers';

export const schedules = pgTable('schedules', {
  id: text('id').primaryKey(),
  serverId: text('server_id').references(() => servers.id, {
    onDelete: 'cascade',
  }), // NULL = global
  taskType: text('task_type').notNull(), // restart|backup|rcon|update-check|storage-scan|tmp-clean|start|stop
  cron: text('cron').notNull(),
  payloadJson: text('payload_json').notNull().default('{}'),
  enabled: boolean('enabled').notNull().default(true),
  lastRunAt: text('last_run_at'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`now()::text`),
});
