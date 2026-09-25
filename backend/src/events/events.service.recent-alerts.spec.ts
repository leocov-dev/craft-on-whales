import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { Test } from '@nestjs/testing';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { EventsService } from './events.service';

// Docker-free: a real in-memory SQLite DB built from the checked-in migration
// SQL (so `events`/`servers` are exercised against the actual schema), same
// setup as discord.service.spec.ts's "alerts category" tests. Covers
// EventsService.recentAlerts — the read method backing the cross-server
// `GET /api/status/summary` endpoint (see ServersController#statusSummary).

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'drizzle');

const migrationFiles = (): string[] =>
  fs
    .readdirSync(MIGRATIONS_DIR)
    .sort()
    .map((dir) => path.join(MIGRATIONS_DIR, dir, 'migration.sql'))
    .filter((f) => fs.existsSync(f));

const SERVER_ID = 'srv_alerts';
const ALERT_EVENT_TYPES = [
  'oom',
  'startup-stalled',
  'schedule-failed',
  'quota-exceeded',
  'auto-restart-failed',
  'recreate-failed',
] as const;

describe('EventsService.recentAlerts', () => {
  let sqlite: DatabaseSync;
  let db: ReturnType<typeof drizzle>;
  let service: EventsService;

  const seedServer = (id: string, name = 'Alerts Test'): void => {
    sqlite
      .prepare(
        `INSERT INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb)
         VALUES (?, ?, 'PAPER', 25701, 26701, 'x', 1024, 1536)`,
      )
      .run(id, name);
  };

  const insertEvent = (
    type: string,
    {
      serverId = SERVER_ID,
      createdAt,
    }: {
      serverId?: string | null;
      createdAt?: string;
    } = {},
  ): void => {
    if (createdAt) {
      sqlite
        .prepare(
          `INSERT INTO events (server_id, actor, type, summary, created_at) VALUES (?, 'system', ?, ?, ?)`,
        )
        .run(serverId, type, `summary for ${type}`, createdAt);
    } else {
      sqlite
        .prepare(
          `INSERT INTO events (server_id, actor, type, summary) VALUES (?, 'system', ?, ?)`,
        )
        .run(serverId, type, `summary for ${type}`);
    }
  };

  /** `YYYY-MM-DD HH:MM:SS` — the shape sqlite's `datetime('now')` writes. */
  const sqlTime = (msAgo: number): string =>
    new Date(Date.now() - msAgo)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, '');

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON');
    for (const file of migrationFiles()) {
      for (const stmt of fs
        .readFileSync(file, 'utf8')
        .split('--> statement-breakpoint')) {
        if (stmt.trim()) sqlite.exec(stmt);
      }
    }
    db = drizzle({ client: sqlite });

    const moduleRef = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: DbService, useValue: { db } },
        {
          provide: ConfigService,
          useValue: { dataDir: '/tmp/events-recent-alerts-spec' },
        },
      ],
    }).compile();
    service = moduleRef.get(EventsService);
    seedServer(SERVER_ID);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('returns only alert-type events, newest first', async () => {
    insertEvent('started');
    insertEvent('oom');
    insertEvent('startup-stalled');
    insertEvent('stopped');

    const rows = await service.recentAlerts(ALERT_EVENT_TYPES, 24);
    expect(rows.map((r) => r.type)).toEqual(['startup-stalled', 'oom']);
  });

  it('joins the server display name onto each row', async () => {
    insertEvent('oom');
    const [row] = await service.recentAlerts(ALERT_EVENT_TYPES, 24);
    expect(row).toMatchObject({
      type: 'oom',
      serverId: SERVER_ID,
      server: 'Alerts Test',
    });
  });

  it('includes panel-global alerts (null server id) with a null server name', async () => {
    insertEvent('schedule-failed', { serverId: null });
    const rows = await service.recentAlerts(ALERT_EVENT_TYPES, 24);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ serverId: null, server: null });
  });

  it('excludes events older than the given window', async () => {
    insertEvent('oom', { createdAt: sqlTime(48 * 60 * 60 * 1000) }); // 48h ago
    insertEvent('recreate-failed', { createdAt: sqlTime(60 * 60 * 1000) }); // 1h ago

    const rows = await service.recentAlerts(ALERT_EVENT_TYPES, 24);
    expect(rows.map((r) => r.type)).toEqual(['recreate-failed']);
  });

  it('returns an empty array when given no types, without querying', async () => {
    insertEvent('oom');
    const rows = await service.recentAlerts([], 24);
    expect(rows).toEqual([]);
  });
});
