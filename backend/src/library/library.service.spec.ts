import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
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

// fs/promises is a pass-through whose `link` the hardlink specs can intercept
// (the namespace export itself cannot be spied on).
jest.mock('node:fs/promises', () => {
  const actual =
    jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, link: jest.fn(actual.link) };
});
const linkMock = fsp.link as jest.MockedFunction<typeof fsp.link>;
const realLink =
  jest.requireActual<typeof import('node:fs/promises')>(
    'node:fs/promises',
  ).link;

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

describe('LibraryService.importFile hardlink', () => {
  let sqlite: DatabaseSync;
  let root: string;
  let src: string;
  let service: LibraryService;
  let record: jest.Mock;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cow-library-hl-'));
    src = path.join(root, 'server-dir');
    fs.mkdirSync(src, { recursive: true });
    sqlite = new DatabaseSync(':memory:');
    for (const file of migrationFiles())
      for (const stmt of fs
        .readFileSync(file, 'utf8')
        .split('--> statement-breakpoint'))
        if (stmt.trim()) sqlite.exec(stmt);
    record = jest.fn();
    linkMock.mockReset();
    linkMock.mockImplementation(realLink);
    const moduleRef = await Test.createTestingModule({
      providers: [
        LibraryService,
        { provide: DbService, useValue: { db: drizzle({ client: sqlite }) } },
        {
          provide: PathGuardService,
          useValue: {
            dataPath: (...parts: string[]) => path.join(root, ...parts),
          },
        },
        { provide: EventsService, useValue: { recordEvent: record } },
        { provide: StorageIndexService, useValue: {} },
        { provide: ServerEnvironmentService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(LibraryService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    sqlite.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (name: string, content: string): string => {
    const p = path.join(src, name);
    fs.writeFileSync(p, content);
    return p;
  };
  const meta = { category: 'datapack' as const, filename: 'a.zip' };
  const linkError = (code: string) => Object.assign(new Error(code), { code });

  it('stores the library copy as a hard link to the source', async () => {
    const p = write('a.zip', 'pack bytes');
    const row = await service.importFile(p, meta, { hardlink: true });
    const dest = path.join(root, row.relPath);
    expect(fs.statSync(dest).ino).toBe(fs.statSync(p).ino);
    expect(fs.readFileSync(dest, 'utf8')).toBe('pack bytes');
  });

  it('attributes the library-added event to the actor', async () => {
    await service.importFile(write('a.zip', 'x'), meta, {
      hardlink: true,
      actor: 'alice',
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'alice', type: 'library-added' }),
    );
  });

  it.each(['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK'])(
    'falls back to a copy when linking fails with %s',
    async (code) => {
      const p = write('a.zip', 'pack bytes');
      linkMock.mockRejectedValue(linkError(code));
      const row = await service.importFile(p, meta, { hardlink: true });
      const dest = path.join(root, row.relPath);
      expect(fs.statSync(dest).ino).not.toBe(fs.statSync(p).ino);
      expect(fs.readFileSync(dest, 'utf8')).toBe('pack bytes');
    },
  );

  it('rethrows other link errors', async () => {
    const p = write('a.zip', 'pack bytes');
    linkMock.mockRejectedValue(linkError('EACCES'));
    await expect(
      service.importFile(p, meta, { hardlink: true }),
    ).rejects.toThrow('EACCES');
    expect(sqlite.prepare('SELECT * FROM library_files').all()).toEqual([]);
  });

  it('replaces a stale leftover at the destination with a link, atomically', async () => {
    const p = write('a.zip', 'pack bytes');
    const sha = crypto.createHash('sha256').update('pack bytes').digest('hex');
    const probe = await service.importFile(write('probe.zip', 'p'), meta, {
      hardlink: true,
    });
    const dir = path.dirname(path.join(root, probe.relPath));
    const stale = path.join(dir, `${sha.slice(0, 8)}-a.zip`);
    fs.writeFileSync(stale, 'stale junk');
    const row = await service.importFile(p, meta, { hardlink: true });
    expect(path.join(root, row.relPath)).toBe(stale);
    expect(fs.statSync(stale).ino).toBe(fs.statSync(p).ino);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps a destination that is already a link to the source', async () => {
    const p = write('a.zip', 'pack bytes');
    const sha = crypto.createHash('sha256').update('pack bytes').digest('hex');
    const probe = await service.importFile(write('probe.zip', 'p'), meta, {
      hardlink: true,
    });
    const dir = path.dirname(path.join(root, probe.relPath));
    const existing = path.join(dir, `${sha.slice(0, 8)}-a.zip`);
    fs.linkSync(p, existing);
    const row = await service.importFile(p, meta, { hardlink: true });
    expect(fs.statSync(path.join(root, row.relPath)).ino).toBe(
      fs.statSync(p).ino,
    );
  });

  it('copies the hashed bytes if the source changed after hashing', async () => {
    const p = write('a.zip', 'pack bytes');
    linkMock.mockImplementation(async (from, to) => {
      await realLink(from, to);
      fs.writeFileSync(p, 'tampered!!!'); // same inode, different bytes
    });
    const row = await service.importFile(p, meta, { hardlink: true });
    const dest = path.join(root, row.relPath);
    expect(fs.readFileSync(dest, 'utf8')).toBe('pack bytes');
    expect(fs.statSync(dest).ino).not.toBe(fs.statSync(p).ino);
  });

  it('refuses a symlink source', async () => {
    const real = write('real.zip', 'secret');
    const link = path.join(src, 'a.zip');
    fs.symlinkSync(real, link);
    await expect(
      service.importFile(link, meta, { hardlink: true }),
    ).rejects.toThrow(/regular file/);
  });

  it('does not link when the sha256 already has a row (dedupe early return)', async () => {
    const first = write('a.zip', 'same bytes');
    const row1 = await service.importFile(first, meta); // plain copy
    const second = write('b.zip', 'same bytes');
    linkMock.mockClear();
    const row2 = await service.importFile(second, meta, { hardlink: true });
    expect(row2.id).toBe(row1.id);
    expect(linkMock).not.toHaveBeenCalled();
    expect(fs.statSync(path.join(root, row2.relPath)).ino).not.toBe(
      fs.statSync(second).ino,
    );
  });
});
