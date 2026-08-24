// Mirrors src/db/migrations/001_init.ts + 002_parity.ts + 006..010's ALTERs to
// the `servers`, `server_packs`, and `server_content` tables — verified
// against the actual post-migration schema (sqlite_master dump), not
// hand-replayed from the migration sequence.

import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const servers = sqliteTable('servers', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  description: text('description').notNull().default(''),
  icon: text('icon').notNull().default('grass'),
  accent: text('accent').notNull().default('#3fa62b'),
  tagsJson: text('tags_json').notNull().default('[]'),
  notes: text('notes').notNull().default(''),

  type: text('type').notNull(),
  mcVersion: text('mc_version').notNull().default('LATEST'),
  javaTag: text('java_tag').notNull().default(''),
  envJson: text('env_json').notNull().default('{}'),

  portGame: integer('port_game').notNull(),
  portRcon: integer('port_rcon').notNull(),
  portQuery: integer('port_query'),
  portBedrock: integer('port_bedrock'),
  rconPasswordCipher: text('rcon_password_cipher').notNull(),

  heapMb: integer('heap_mb').notNull(),
  containerMemoryMb: integer('container_memory_mb').notNull(),
  containerSwapMb: integer('container_swap_mb').notNull().default(0),
  cpus: real('cpus').notNull().default(0),
  diskQuotaBytes: integer('disk_quota_bytes').notNull().default(0),
  quotaStrict: integer('quota_strict', { mode: 'boolean' })
    .notNull()
    .default(false),

  updatePolicy: text('update_policy').notNull().default('manual'), // 'manual' | 'notify' | 'auto'
  autoStart: integer('auto_start', { mode: 'boolean' })
    .notNull()
    .default(false),
  autoRestart: integer('auto_restart', { mode: 'boolean' })
    .notNull()
    .default(true),

  containerId: text('container_id'),
  pendingRecreate: integer('pending_recreate', { mode: 'boolean' })
    .notNull()
    .default(false),
  status: text('status').notNull().default('stopped'),
  lastStartedAt: text('last_started_at'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  deletedAt: text('deleted_at'),

  consoleLabel: text('console_label'),
  containerName: text('container_name'),
  networkName: text('network_name'),
  extraPortsJson: text('extra_ports_json').notNull().default('[]'),
  extraBindsJson: text('extra_binds_json').notNull().default('[]'),
  routerHostname: text('router_hostname'),
  routerAutoScale: text('router_auto_scale'), // 'on' | 'off' | null
});

export const serverPacks = sqliteTable('server_packs', {
  serverId: text('server_id')
    .primaryKey()
    .references(() => servers.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(), // 'curseforge' | 'modrinth' | 'ftb' | 'gtnh'
  projectRef: text('project_ref').notNull(),
  projectName: text('project_name').notNull(),
  pinnedVersionId: text('pinned_version_id').notNull(),
  pinnedVersionName: text('pinned_version_name').notNull(),
  previousVersionId: text('previous_version_id'),
  previousVersionName: text('previous_version_name'),
  installedAt: text('installed_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  maxJavaVersion: integer('max_java_version'),
  channel: text('channel'),
});

export const serverContent = sqliteTable(
  'server_content',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    libraryId: text('library_id'), // references library_files.id — see schema/library.ts
    kind: text('kind').notNull(), // 'mod' | 'plugin' | 'datapack' | 'resourcepack'
    managedBy: text('managed_by').notNull(), // 'pack' | 'overlay'
    name: text('name').notNull(),
    filename: text('filename').notNull(),
    version: text('version'),
    iconUrl: text('icon_url'),
    iconRelPath: text('icon_rel_path'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    installedAt: text('installed_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [
    uniqueIndex('server_content_server_filename').on(t.serverId, t.filename),
  ],
);
