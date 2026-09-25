import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { Test } from '@nestjs/testing';
import { DbService } from '../db/db.service';
import { SecretsService } from '../auth/secrets.service';
import { DiscordService } from './discord.service';

// Docker-free: a real in-memory SQLite DB built from the checked-in migration
// SQL (so `integrations`/`events`/`servers` are exercised against the actual
// schema), and a stub SecretsService (a fixed reversible transform — real
// AES-GCM needs a ConfigService we don't otherwise need here). global.fetch
// is mocked per-test so no real webhook is ever hit.

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'drizzle');

const migrationFiles = (): string[] =>
  fs
    .readdirSync(MIGRATIONS_DIR)
    .sort()
    .map((dir) => path.join(MIGRATIONS_DIR, dir, 'migration.sql'))
    .filter((f) => fs.existsSync(f));

const SERVER_ID = 'srv_alerts';
const WEBHOOK_URL = 'https://discord.com/api/webhooks/123/abc';

describe('DiscordService — alerts category', () => {
  let sqlite: DatabaseSync;
  let db: ReturnType<typeof drizzle>;
  let service: DiscordService;
  const originalFetch = global.fetch;

  const seedServer = (id: string): void => {
    sqlite
      .prepare(
        `INSERT INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb)
         VALUES (?, 'Alerts Test', 'PAPER', 25701, 26701, 'x', 1024, 1536)`,
      )
      .run(id);
  };

  const insertEvent = (
    type: string,
    serverId: string | null = SERVER_ID,
  ): void => {
    sqlite
      .prepare(
        `INSERT INTO events (server_id, actor, type, summary) VALUES (?, 'system', ?, ?)`,
      )
      .run(serverId, type, `summary for ${type}`);
  };

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
        DiscordService,
        { provide: DbService, useValue: { db } },
        {
          provide: SecretsService,
          useValue: {
            // Fixed, reversible stand-in — real encryption is covered by
            // SecretsService's own spec, not needed to exercise the bridge.
            encrypt: (plaintext: string) => `enc:${plaintext}`,
            decrypt: (cipher: string) => cipher.replace(/^enc:/, ''),
          },
        },
      ],
    }).compile();
    service = moduleRef.get(DiscordService);
    seedServer(SERVER_ID);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    sqlite.close();
  });

  it('DEFAULT_EVENTS enables the new alerts category by default, like every other category', async () => {
    const cfg = await service.getConfig(SERVER_ID);
    expect(cfg.events).toEqual({
      lifecycle: true,
      crashes: true,
      backups: true,
      updates: true,
      players: true,
      alerts: true,
    });
  });

  it('round-trips the alerts toggle through setConfig/getConfig independent of other categories', async () => {
    await service.setConfig(SERVER_ID, {
      enabled: true,
      webhookUrl: WEBHOOK_URL,
      events: { alerts: false },
    });
    const cfg = await service.getConfig(SERVER_ID);
    expect(cfg.events.alerts).toBe(false);
    // Untouched categories keep their defaults.
    expect(cfg.events.crashes).toBe(true);
    expect(cfg.events.lifecycle).toBe(true);
  });

  describe.each([
    'oom',
    'startup-stalled',
    'schedule-failed',
    'quota-exceeded',
    'auto-restart-failed',
    'recreate-failed',
  ])('event type %s', (type) => {
    it('is forwarded under the alerts category when alerts is enabled', async () => {
      await service.setConfig(SERVER_ID, {
        enabled: true,
        webhookUrl: WEBHOOK_URL,
      });
      const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
      global.fetch = fetchMock;

      service.startEventBridge({ intervalMs: 60_000 });
      // Let the async high-water-mark lookup settle before the event exists,
      // so it doesn't capture this test's own row as "already seen".
      await new Promise((r) => setTimeout(r, 0));
      insertEvent(type);
      await (
        service as unknown as { pollOnce: () => Promise<void> }
      ).pollOnce();
      service.stopEventBridge();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
      expect(url).toBe(WEBHOOK_URL);
      const body = JSON.parse(init.body) as {
        embeds: { color: number; title: string }[];
      };
      expect(body.embeds[0]?.color).toBe(0xe5484d);
    });

    it('is NOT forwarded when the alerts category is toggled off', async () => {
      await service.setConfig(SERVER_ID, {
        enabled: true,
        webhookUrl: WEBHOOK_URL,
        events: { alerts: false },
      });
      const fetchMock = jest.fn();
      global.fetch = fetchMock;

      service.startEventBridge({ intervalMs: 60_000 });
      await new Promise((r) => setTimeout(r, 0));
      insertEvent(type);
      await (
        service as unknown as { pollOnce: () => Promise<void> }
      ).pollOnce();
      service.stopEventBridge();

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('does not map an unrelated, already-categorized event type into alerts', async () => {
    await service.setConfig(SERVER_ID, {
      enabled: true,
      webhookUrl: WEBHOOK_URL,
    });
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock;

    service.startEventBridge({ intervalMs: 60_000 });
    await new Promise((r) => setTimeout(r, 0));
    insertEvent('started'); // lifecycle, not alerts
    await (service as unknown as { pollOnce: () => Promise<void> }).pollOnce();
    service.stopEventBridge();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const body = JSON.parse(init.body) as {
      embeds: { color: number }[];
    };
    expect(body.embeds[0]?.color).toBe(0x3fa62b); // start color, not alert red
  });
});
