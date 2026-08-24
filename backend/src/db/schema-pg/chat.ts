// Postgres mirror of ../schema/chat.ts — see ./PG_SCHEMA_NOTES.md.

import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  integer,
  boolean,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

export const chatCommandSettings = pgTable('chat_command_settings', {
  serverId: text('server_id').primaryKey(),
  prefix: text('prefix').notNull().default('!'),
});

export const chatCommands = pgTable(
  'chat_commands',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id').notNull(),
    trigger: text('trigger').notNull(),
    description: text('description').notNull().default(''),
    action: text('action').notNull(), // 'rtp' | 'structure' | 'biome' | 'console'
    params: text('params').notNull().default('{}'),
    permission: text('permission').notNull().default('everyone'), // everyone|whitelist|ops
    cooldownSec: integer('cooldown_sec').notNull().default(30),
    enabled: boolean('enabled').notNull().default(true),
    uses: integer('uses').notNull().default(0),
    lastUsedAt: text('last_used_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`now()::text`),
    msgPending: text('msg_pending'),
    msgSuccess: text('msg_success'),
    msgFailure: text('msg_failure'),
  },
  (t) => [
    index('idx_chatcmd_server').on(t.serverId),
    uniqueIndex('chat_commands_server_trigger').on(t.serverId, t.trigger),
  ],
);
