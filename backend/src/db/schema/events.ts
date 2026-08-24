import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    serverId: text('server_id'), // NULL = panel-global event
    actor: text('actor').notNull(),
    type: text('type').notNull(),
    summary: text('summary').notNull(),
    detailsJson: text('details_json').notNull().default('{}'),
    logExcerptPath: text('log_excerpt_path'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [
    index('idx_events_created').on(t.createdAt),
    index('idx_events_server').on(t.serverId, t.createdAt),
    index('idx_events_type').on(t.type),
  ],
);

export const crashReports = sqliteTable(
  'crash_reports',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id').notNull(),
    filename: text('filename').notNull(),
    fileMtime: text('file_mtime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    summary: text('summary').notNull().default(''),
    exception: text('exception').notNull().default(''),
    suspectedJson: text('suspected_json').notNull().default('[]'),
    eventId: integer('event_id').references(() => events.id),
    viewed: integer('viewed', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (t) => [
    uniqueIndex('crash_reports_server_filename').on(t.serverId, t.filename),
  ],
);

export const playerEvents = sqliteTable(
  'player_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    serverId: text('server_id').notNull(),
    ts: text('ts').notNull(),
    type: text('type').notNull(), // chat|join|leave|death|advancement|pvp|command
    player: text('player').notNull().default(''),
    target: text('target').notNull().default(''),
    message: text('message').notNull().default(''),
    raw: text('raw').notNull().default(''),
  },
  (t) => [
    index('idx_pevents_player').on(t.player),
    index('idx_pevents_server_ts').on(t.serverId, t.ts),
    index('idx_pevents_type').on(t.type),
  ],
);

export const playerSessions = sqliteTable(
  'player_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    serverId: text('server_id').notNull(),
    player: text('player').notNull(),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'), // NULL = session open
  },
  (t) => [
    uniqueIndex('idx_sessions_player').on(t.serverId, t.player, t.startedAt),
  ],
);

export const playerStatSnapshots = sqliteTable(
  'player_stat_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    serverId: text('server_id').notNull(),
    uuid: text('uuid').notNull(),
    name: text('name').notNull().default(''),
    ts: text('ts')
      .notNull()
      .default(sql`(datetime('now'))`),
    statsJson: text('stats_json').notNull(),
  },
  (t) => [index('idx_statsnap').on(t.serverId, t.uuid, t.ts)],
);
