import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { servers } from './servers';

export const schedules = sqliteTable('schedules', {
  id: text('id').primaryKey(),
  serverId: text('server_id').references(() => servers.id, {
    onDelete: 'cascade',
  }), // NULL = global
  taskType: text('task_type').notNull(), // restart|backup|rcon|update-check|storage-scan|tmp-clean|start|stop
  cron: text('cron').notNull(),
  payloadJson: text('payload_json').notNull().default('{}'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastRunAt: text('last_run_at'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});
