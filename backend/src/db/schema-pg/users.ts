// Postgres mirror of ../schema/users.ts — see ./PG_SCHEMA_NOTES.md.

import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  integer,
  boolean,
  primaryKey,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  // COLLATE NOCASE on the source column has no equivalent here — see
  // ./PG_SCHEMA_NOTES.md and ../DRIZZLE_NOTES.md.
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('admin'), // 'admin' | 'operator' | 'viewer'
  createdAt: text('created_at')
    .notNull()
    .default(sql`now()::text`),
  totpSecret: text('totp_secret'),
  totpEnabled: boolean('totp_enabled').notNull().default(false),
  totpBackupCodesJson: text('totp_backup_codes_json'),
  totpLastStep: integer('totp_last_step'),
});

export const sessions = pgTable('sessions', {
  sid: text('sid').primaryKey(),
  dataJson: text('data_json').notNull(),
  expiresAt: text('expires_at').notNull(),
});

export const userServerPermissions = pgTable(
  'user_server_permissions',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    serverId: text('server_id').notNull(),
    perms: text('perms').notNull().default('view'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.serverId] })],
);
