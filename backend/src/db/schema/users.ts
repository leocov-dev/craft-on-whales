import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
} from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  // COLLATE NOCASE on the source column — Drizzle's sqlite-core has no first-class
  // collation builder, so this is applied via a raw index in a migration (see
  // db/DRIZZLE_NOTES.md) rather than expressed here.
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('admin'), // 'admin' | 'operator' | 'viewer'
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  totpSecret: text('totp_secret'),
  totpEnabled: integer('totp_enabled', { mode: 'boolean' })
    .notNull()
    .default(false),
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
  (t) => [primaryKey({ columns: [t.userId, t.serverId] })],
);

/**
 * Admin-minted Bearer tokens for the public read-only API
 * (`backend/src/api-tokens/`, upstream parity item 3.17). `tokenHash` is a
 * sha256 hex digest — the raw token is shown once at mint time and never
 * stored. `createdBy` is a plain username snapshot (matches `events.actor`'s
 * style, not a FK) so a token survives the admin account that minted it
 * being deleted. `serverIdsJson: null` means "all servers"; a JSON array
 * scopes the token to just those ids (mirrors `userServerPermissions.perms`'s
 * free-text JSON convention). See API_TOKENS_NOTES.md.
 */
export const apiTokens = sqliteTable('api_tokens', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  label: text('label').notNull(),
  createdBy: text('created_by').notNull(),
  serverIdsJson: text('server_ids_json'), // null = all servers
  expiresAt: text('expires_at'),
  revoked: integer('revoked', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  lastUsedAt: text('last_used_at'),
});
