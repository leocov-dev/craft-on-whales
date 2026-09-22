import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { PathGuardService } from '../storage/path-guard.service';
import { StorageIndexService } from '../storage/storage-index.service';
import { EventsService } from '../events/events.service';
import { ServerEnvironmentService } from '../servers/server-environment.service';
import { LibraryService } from './library.service';

// Real in-memory SQLite built from the checked-in migrations (so dedupe
// inserts run against the actual schema), a real PathGuardService pointed
// at a scratch tmp dir, and stubs for everything downloadToLibrary doesn't
// exercise. global.fetch is mocked per-test so no network is touched.

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'drizzle');

const migrationFiles = (): string[] =>
  fs
    .readdirSync(MIGRATIONS_DIR)
    .sort()
    .map((dir) => path.join(MIGRATIONS_DIR, dir, 'migration.sql'))
    .filter((f) => fs.existsSync(f));

function fakeResponse(body: Buffer, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: {
      get: (name: string) =>
        name === 'content-length' ? String(body.length) : null,
    },
    body: Readable.from(body) as unknown as ReadableStream,
  };
}

describe('LibraryService — checksum verification', () => {
  let sqlite: DatabaseSync;
  let db: ReturnType<typeof drizzle>;
  let root: string;
  let service: LibraryService;
  const originalFetch = global.fetch;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cow-library-'));
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
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
        LibraryService,
        { provide: DbService, useValue: { db } },
        {
          provide: PathGuardService,
          useValue: {
            dataPath: (...parts: string[]) => path.join(root, ...parts),
          },
        },
        {
          provide: EventsService,
          useValue: { recordEvent: jest.fn() },
        },
        {
          provide: StorageIndexService,
          useValue: {
            diskFree: () => Promise.resolve({ free: 1024 ** 4 }),
          },
        },
        {
          provide: ServerEnvironmentService,
          useValue: { ensureOwnership: jest.fn() },
        },
      ],
    }).compile();
    service = moduleRef.get(LibraryService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    sqlite.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const tmpDirFiles = (): string[] => {
    const dir = path.join(root, 'tmp');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  };

  it('accepts a download whose bytes match the registry-published checksum', async () => {
    const content = Buffer.from('a real mod jar, presumably');
    const sha512 = crypto.createHash('sha512').update(content).digest('hex');
    global.fetch = jest.fn().mockResolvedValue(fakeResponse(content));

    const row = await service.downloadToLibrary('https://cdn.example/mod.jar', {
      category: 'mod',
      filename: 'mod.jar',
      name: 'Real Mod',
      expectedHash: { algorithm: 'sha512', hex: sha512 },
    });

    expect(row.sha256).toBe(
      crypto.createHash('sha256').update(content).digest('hex'),
    );
    expect(fs.existsSync(path.join(root, row.relPath))).toBe(true);
    expect(tmpDirFiles()).toEqual([]); // temp file renamed away, none left behind
  });

  it('rejects and cleans up a download whose bytes do not match the registry checksum', async () => {
    const content = Buffer.from('a tampered or corrupted payload');
    const wrongHash = crypto
      .createHash('sha512')
      .update('something else entirely')
      .digest('hex');
    global.fetch = jest.fn().mockResolvedValue(fakeResponse(content));

    await expect(
      service.downloadToLibrary('https://cdn.example/mod.jar', {
        category: 'mod',
        filename: 'mod.jar',
        name: 'Tampered Mod',
        expectedHash: { algorithm: 'sha512', hex: wrongHash },
      }),
    ).rejects.toThrow(/checksum mismatch/i);

    // Nothing left in tmp/, and nothing committed to the library dir or DB.
    expect(tmpDirFiles()).toEqual([]);
    expect(
      fs.existsSync(path.join(root, 'library', 'mods')) &&
        fs.readdirSync(path.join(root, 'library', 'mods')).length > 0,
    ).toBe(false);
    const rows = sqlite
      .prepare('SELECT COUNT(*) AS n FROM library_files')
      .get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
  });

  it('skips verification and logs a warning when the source gave no checksum', async () => {
    const content = Buffer.from(
      'a direct-URL download with nothing to verify against',
    );
    global.fetch = jest.fn().mockResolvedValue(fakeResponse(content));
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    const row = await service.downloadToLibrary(
      'https://cdn.example/direct.jar',
      { category: 'mod', filename: 'direct.jar', name: 'Unverified Mod' },
    );

    expect(warnSpy).toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, row.relPath))).toBe(true);
  });
});
