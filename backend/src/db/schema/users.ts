import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  // COLLATE NOCASE on the source column — Drizzle's sqlite-core has no first-class
  // collation builder, so this is applied via a raw index in a migration (see
  // db/DRIZZLE_NOTES.md) rather than expressed here.
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('admin'), // 'admin' | 'operator' | 'viewer'
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  totpSecret: text('totp_secret'),
  totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
  totpBackupCodesJson: text('totp_backup_codes_json'),
  totpLastStep: integer('totp_last_step'),
});

export const sessions = sqliteTable('sessions', {
  sid: text('sid').primaryKey(),
  dataJson: text('data_json').notNull(),
  expiresAt: text('expires_at').notNull(),
});

export const userServerPermissions = sqliteTable(
  'user_server_permissions',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    serverId: text('server_id').notNull(),
    perms: text('perms').notNull().default('view'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.serverId] })]
);
