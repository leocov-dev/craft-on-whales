import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { Test } from '@nestjs/testing';
import { DbService } from '../db/db.service';
import { ContainerService } from '../docker/container.service';
import { ServerLifecycleService } from '../servers/server-lifecycle.service';
import { PathGuardService } from '../storage/path-guard.service';
import { StorageIndexService } from '../storage/storage-index.service';
import { EventsService } from '../events/events.service';
import { backups } from '../db/schema';
import { WorldArchiveService } from './world-archive.service';
import { WorldSaveLockService } from './world-save-lock.service';
import { BackupsService, RETENTION_BUCKETS } from './backups.service';

// Docker-free: a real in-memory SQLite DB built from the checked-in migration
// SQL (so retention is exercised against the actual schema and real Drizzle
// query building), a real WorldArchiveService (pure fs/zip plumbing), and
// stubs for everything that would touch Docker or the indexer.

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'drizzle');

/** Every migration.sql under drizzle/, oldest first — folder names sort
 *  chronologically (drizzle-kit's timestamp prefix), so a plain sort suffices. */
const migrationFiles = (): string[] =>
  fs
    .readdirSync(MIGRATIONS_DIR)
    .sort()
    .map((dir) => path.join(MIGRATIONS_DIR, dir, 'migration.sql'))
    .filter((f) => fs.existsSync(f));

const SERVER_ID = 'srv_ret';

interface RecordedEvent {
  type: string;
  details?: { entryCount?: number; empty?: boolean };
}

describe('BackupsService', () => {
  let sqlite: DatabaseSync;
  let db: ReturnType<typeof drizzle>;
  let root: string;
  let service: BackupsService;
  let recordEvent: jest.Mock;

  const seedServer = (id: string): void => {
    sqlite
      .prepare(
        `INSERT INTO servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb)
         VALUES (?, 'Retention Test', 'PAPER', 25601, 26601, 'x', 1024, 1536)`,
      )
      .run(id);
  };

  // created_at grows with i, so a higher i means newer, means kept.
  const seedBackups = (
    serverId: string,
    reason: string,
    count: number,
  ): void => {
    for (let i = 0; i < count; i++) {
      const n = String(i).padStart(3, '0');
      const rel = `backups/${serverId}/${serverId}-${reason}-${n}.zip`;
      sqlite
        .prepare(
          `INSERT INTO backups (id, server_id, filename, rel_path, size_bytes, reason, created_at)
           VALUES (?, ?, ?, ?, 1024, ?, datetime('2026-01-01 00:00:00', '+' || ? || ' minutes'))`,
        )
        .run(
          `bk_${serverId}_${reason}_${n}`,
          serverId,
          path.basename(rel),
          rel,
          reason,
          i,
        );
    }
  };

  const countByReason = (serverId: string, reason: string): number =>
    (
      sqlite
        .prepare(
          'SELECT COUNT(*) AS n FROM backups WHERE server_id = ? AND reason = ?',
        )
        .get(serverId, reason) as { n: number }
    ).n;

  const recordedEvents = (): RecordedEvent[] =>
    (recordEvent.mock.calls as unknown as [RecordedEvent][]).map((c) => c[0]);

  const exists = (id: string): boolean =>
    Boolean(sqlite.prepare('SELECT 1 AS x FROM backups WHERE id = ?').get(id));

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cow-backups-'));
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
    recordEvent = jest.fn();

    const moduleRef = await Test.createTestingModule({
      providers: [
        BackupsService,
        WorldArchiveService,
        { provide: DbService, useValue: { db } },
        {
          provide: PathGuardService,
          useValue: {
            dataPath: (...parts: string[]) => path.join(root, ...parts),
            safeJoin: (base: string, ...parts: string[]) =>
              path.join(base, ...parts),
          },
        },
        {
          provide: ContainerService,
          useValue: {
            inspectStatus: () =>
              Promise.resolve({ exists: false, status: 'stopped' }),
          },
        },
        {
          provide: ServerLifecycleService,
          useValue: { stopServer: jest.fn() },
        },
        {
          provide: StorageIndexService,
          useValue: {
            sizeOf: () => Promise.resolve(1024),
            diskFree: () => Promise.resolve({ free: 1024 ** 4 }),
            scan: () => Promise.resolve(),
          },
        },
        { provide: EventsService, useValue: { recordEvent } },
        {
          provide: WorldSaveLockService,
          useValue: {
            withSaveLock: (_key: string, fn: () => Promise<unknown>) => fn(),
          },
        },
      ],
    }).compile();
    service = moduleRef.get(BackupsService);
    seedServer(SERVER_ID);
  });

  afterEach(() => {
    sqlite.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('pruneRetention', () => {
    it('caps every reason bucket at its own ceiling, keeping the newest', async () => {
      seedBackups(SERVER_ID, 'scheduled', 15);
      seedBackups(SERVER_ID, 'pre-update', 13);
      seedBackups(SERVER_ID, 'manual', 25);
      seedBackups(SERVER_ID, 'pre-restore', 8);

      const deleted = await service.pruneRetention(SERVER_ID, {
        actor: 'test',
      });

      expect(countByReason(SERVER_ID, 'scheduled')).toBe(10);
      expect(countByReason(SERVER_ID, 'pre-update')).toBe(10);
      expect(countByReason(SERVER_ID, 'manual')).toBe(20);
      expect(countByReason(SERVER_ID, 'pre-restore')).toBe(5);
      expect(deleted).toBe(5 + 3 + 5 + 3);

      // manual: i=0..24, newest 20 kept -> i=5..24 survive, i=0..4 pruned.
      expect(exists(`bk_${SERVER_ID}_manual_004`)).toBe(false);
      expect(exists(`bk_${SERVER_ID}_manual_005`)).toBe(true);
      // The newest row in each bucket always survives.
      expect(exists(`bk_${SERVER_ID}_manual_024`)).toBe(true);
      expect(exists(`bk_${SERVER_ID}_scheduled_014`)).toBe(true);
      expect(exists(`bk_${SERVER_ID}_pre-update_012`)).toBe(true);
      expect(exists(`bk_${SERVER_ID}_pre-restore_007`)).toBe(true);
    });

    it('is a no-op when every bucket is under its cap', async () => {
      seedBackups(SERVER_ID, 'manual', 3);
      seedBackups(SERVER_ID, 'scheduled', 3);
      seedBackups(SERVER_ID, 'pre-restore', 3);

      expect(await service.pruneRetention(SERVER_ID)).toBe(0);
      expect(countByReason(SERVER_ID, 'manual')).toBe(3);
      expect(countByReason(SERVER_ID, 'scheduled')).toBe(3);
      expect(countByReason(SERVER_ID, 'pre-restore')).toBe(3);
    });

    it('never lets a pre-restore snapshot evict a manual backup', async () => {
      seedBackups(SERVER_ID, 'manual', 20); // exactly at its ceiling
      seedBackups(SERVER_ID, 'pre-restore', 20); // way over its own

      const deleted = await service.pruneRetention(SERVER_ID);

      expect(countByReason(SERVER_ID, 'manual')).toBe(20);
      expect(exists(`bk_${SERVER_ID}_manual_000`)).toBe(true); // oldest manual untouched
      expect(countByReason(SERVER_ID, 'pre-restore')).toBe(5);
      expect(deleted).toBe(15);
    });

    it('prunes per bucket, not against a global total', async () => {
      // 12 rows overall, no bucket over its own cap -> nothing is pruned.
      seedBackups(SERVER_ID, 'scheduled', 3);
      seedBackups(SERVER_ID, 'pre-update', 3);
      seedBackups(SERVER_ID, 'manual', 3);
      seedBackups(SERVER_ID, 'pre-restore', 3);

      expect(await service.pruneRetention(SERVER_ID)).toBe(0);
    });

    it('leaves another server’s backups alone', async () => {
      seedServer('srv_other');
      seedBackups('srv_other', 'scheduled', 15);
      seedBackups(SERVER_ID, 'scheduled', 15);

      await service.pruneRetention(SERVER_ID);

      expect(countByReason(SERVER_ID, 'scheduled')).toBe(10);
      expect(countByReason('srv_other', 'scheduled')).toBe(15);
    });

    it('exposes the documented ceilings', () => {
      expect(
        Object.fromEntries(RETENTION_BUCKETS.map((b) => [b[0], b[1]])),
      ).toEqual({
        scheduled: 10,
        'pre-update': 10,
        manual: 20,
        'pre-restore': 5,
      });
    });
  });

  describe('createBackup integrity check', () => {
    beforeEach(() => {
      const dir = path.join(root, 'servers', SERVER_ID);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'server.properties'), 'level-name=world');
    });

    it('records a backup whose archive opens cleanly', async () => {
      const row = await service.createBackup(SERVER_ID, { reason: 'manual' });

      expect(row.reason).toBe('manual');
      expect(fs.existsSync(path.join(root, row.relPath))).toBe(true);
      const rows = await db.select().from(backups);
      expect(rows).toHaveLength(1);
      const created = recordedEvents().find((e) => e.type === 'backup-created');
      expect(created?.details?.entryCount).toBe(1);
      expect(created?.details?.empty).toBe(false);
    });

    it('discards a corrupt archive and keeps it out of the DB', async () => {
      // Write something that is not a readable zip where the archive belongs.
      jest
        .spyOn(
          service as unknown as {
            zipDirectory: (src: string, out: string) => Promise<void>;
          },
          'zipDirectory',
        )
        .mockImplementation((_src: string, out: string) => {
          fs.writeFileSync(out, 'this is not a zip file');
          return Promise.resolve();
        });

      await expect(
        service.createBackup(SERVER_ID, { reason: 'manual' }),
      ).rejects.toThrow(/integrity check/i);

      expect(await db.select().from(backups)).toHaveLength(0);
      const dir = path.join(root, 'backups', SERVER_ID);
      expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
      expect(recordedEvents().some((e) => e.type === 'backup-created')).toBe(
        false,
      );
    });
  });
});
