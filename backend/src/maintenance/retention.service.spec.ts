import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import type { DbService } from '../db/db.service';
import type { EventsService } from '../events/events.service';
import { RetentionService } from './retention.service';

// Real in-memory SQLite built from the checked-in migrations, so the deletes
// run against the actual schema.
const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'drizzle');

const daysAgo = (n: number): Date => new Date(Date.now() - n * 86_400_000);
const iso = (d: Date): string => d.toISOString();
const sqlTime = (d: Date): string =>
  d.toISOString().slice(0, 19).replace('T', ' ');

describe('RetentionService', () => {
  let sqlite: DatabaseSync;
  let service: RetentionService;
  let pruneEvents: jest.Mock;

  const count = (table: string): number =>
    (
      sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
        n: number;
      }
    ).n;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    for (const dir of fs.readdirSync(MIGRATIONS_DIR).sort()) {
      const file = path.join(MIGRATIONS_DIR, dir, 'migration.sql');
      if (fs.existsSync(file)) sqlite.exec(fs.readFileSync(file, 'utf8'));
    }
    pruneEvents = jest.fn().mockResolvedValue({ removed: 7 });
    service = new RetentionService(
      { db: drizzle({ client: sqlite }) } as unknown as DbService,
      { pruneEvents } as unknown as EventsService,
    );
  });
  afterEach(() => sqlite.close());

  const addPlayerEvent = (ts: string) =>
    sqlite
      .prepare(
        `INSERT INTO player_events (server_id, ts, type) VALUES ('srv_a', ?, 'join')`,
      )
      .run(ts);
  const addSession = (startedAt: string, endedAt: string | null) =>
    sqlite
      .prepare(
        `INSERT INTO player_sessions (server_id, player, started_at, ended_at) VALUES ('srv_a', 'Steve', ?, ?)`,
      )
      .run(startedAt, endedAt);
  const addCache = (key: string, fetchedAt: string) =>
    sqlite
      .prepare(
        `INSERT INTO api_cache (key, value_json, fetched_at) VALUES (?, '{}', ?)`,
      )
      .run(key, fetchedAt);

  it('prunes analytics rows and closed sessions past the cutoff, never open sessions', async () => {
    addPlayerEvent(iso(daysAgo(120)));
    addPlayerEvent(iso(daysAgo(10)));
    addSession(iso(daysAgo(130)), iso(daysAgo(120))); // old + closed -> gone
    addSession(iso(daysAgo(129)), iso(daysAgo(5))); // closed recently -> kept
    addSession(iso(daysAgo(128)), null); // old but still open -> kept

    const r = await service.pruneAnalytics(90);

    expect(r).toEqual({ playerEvents: 1, playerSessions: 1 });
    expect(count('player_events')).toBe(1);
    expect(count('player_sessions')).toBe(2);
  });

  it('prunes stale api_cache entries but spares the item registry and fresh rows', async () => {
    addCache('search:old', sqlTime(daysAgo(45)));
    addCache('search:fresh', sqlTime(daysAgo(2)));
    addCache('item-registry:srv_a', sqlTime(daysAgo(400)));

    expect(await service.pruneApiCache(30)).toBe(1);

    const keys = (
      sqlite.prepare('SELECT key FROM api_cache ORDER BY key').all() as {
        key: string;
      }[]
    ).map((r) => r.key);
    expect(keys).toEqual(['item-registry:srv_a', 'search:fresh']);
  });

  it('pruneAll combines every step, using the retention windows', async () => {
    addPlayerEvent(iso(daysAgo(91)));
    addCache('x', sqlTime(daysAgo(31)));

    expect(await service.pruneAll()).toEqual({
      playerEvents: 1,
      playerSessions: 0,
      events: 7,
      apiCache: 1,
    });
    expect(pruneEvents).toHaveBeenCalledWith(365);
  });
});
