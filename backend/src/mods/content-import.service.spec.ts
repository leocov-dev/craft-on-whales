import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import {
  BadRequestException,
  Logger,
  PreconditionFailedException,
} from '@nestjs/common';
import { buildZipFixture } from '../utils/zip-fixture.test-helpers';
import { PathGuardService } from '../storage/path-guard.service';
import { LibraryService } from '../library/library.service';
import { ModsService } from './mods.service';
import { JarIdentifierService } from './jar-identifier.service';
import { PackOverridesService } from './pack-overrides.service';
import { ContentImportService, jarMisfit } from './content-import.service';
import type { ModrinthProject, ModrinthVersionWithProject } from './mods.types';
import type { ContentImportReport } from '../../../shared/types/mods';

// End to end through the real pieces that touch disk and the DB: a
// migrated in-memory SQLite, a real PathGuardService on a scratch data dir,
// the real safe zip extractor, LibraryService, ModsService's install tail,
// JarIdentifierService's chain (registries faked) and PackOverridesService.
// Only the network (fetch, Modrinth, CurseForge) is stubbed.

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'drizzle');
const SERVER_ID = 'srv1';

const sha = (algo: string, b: Buffer | string) =>
  crypto.createHash(algo).update(b).digest('hex');

const fabricJar = (id: string) =>
  buildZipFixture([
    {
      name: 'fabric.mod.json',
      content: JSON.stringify({ id, name: `${id} mod`, version: '1.0.0' }),
    },
  ]);
const forgeJar = (id: string) =>
  buildZipFixture([
    {
      name: 'META-INF/mods.toml',
      content: `[[mods]]\nmodId="${id}"\nversion="2.0"\ndisplayName="${id} forge"\n`,
    },
  ]);
const pluginJar = (name: string) =>
  buildZipFixture([
    { name: 'plugin.yml', content: `name: ${name}\nversion: 1.0\nmain: a.B\n` },
  ]);

function fakeResponse(body: Buffer) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (h: string) => (h === 'content-length' ? String(body.length) : null),
    },
    body: Readable.from(body) as unknown as ReadableStream,
  } as unknown as Response;
}

describe('ContentImportService', () => {
  let root: string;
  let dataDir: string;
  let serverDir: string;
  let sqlite: DatabaseSync;
  let service: ContentImportService;
  let overrides: PackOverridesService;
  let library: LibraryService;
  let modrinth: {
    getVersionsByHashes: jest.Mock;
    getProjects: jest.Mock;
  };
  let server: {
    id: string;
    type: string;
    mc_version: string;
    env: Record<string, string>;
    disk_quota_bytes: number;
  };
  let knownModrinth: Map<string, ModrinthVersionWithProject>;
  let downloads: Map<string, Buffer>;
  let archiveN = 0;

  const archive = (entries: Record<string, Buffer | string>): string => {
    const file = path.join(root, `upload-${++archiveN}.zip`);
    fs.writeFileSync(
      file,
      buildZipFixture(
        Object.entries(entries).map(([name, content]) => ({ name, content })),
      ),
    );
    return file;
  };
  const run = (
    entries: Record<string, Buffer | string>,
    opts: { applyOverrides?: boolean } = {},
    name = 'pack.zip',
  ): Promise<ContentImportReport> =>
    service.importArchive(SERVER_ID, archive(entries), name, {
      actor: 'tester',
      ...opts,
    });
  const serverFile = (rel: string) => path.join(serverDir, rel);
  const put = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(serverFile(rel)), { recursive: true });
    fs.writeFileSync(serverFile(rel), content);
  };
  const read = (rel: string) => fs.readFileSync(serverFile(rel), 'utf8');
  const rows = (table: string) =>
    sqlite.prepare(`select * from ${table}`).all() as Record<string, unknown>[];

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cow-imp-')));
    dataDir = path.join(root, 'data');
    serverDir = path.join(dataDir, 'servers', SERVER_ID);
    fs.mkdirSync(path.join(dataDir, 'tmp'), { recursive: true });
    fs.mkdirSync(serverDir, { recursive: true });

    sqlite = new DatabaseSync(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON');
    for (const dir of fs.readdirSync(MIGRATIONS_DIR).sort()) {
      const file = path.join(MIGRATIONS_DIR, dir, 'migration.sql');
      if (!fs.existsSync(file)) continue;
      for (const stmt of fs
        .readFileSync(file, 'utf8')
        .split('--> statement-breakpoint'))
        if (stmt.trim()) sqlite.exec(stmt);
    }
    sqlite.exec(
      `insert into servers (id, display_name, type, port_game, port_rcon, rcon_password_cipher, heap_mb, container_memory_mb)
       values ('${SERVER_ID}', 'Test', 'FABRIC', 25565, 25575, 'x', 1024, 2048)`,
    );
    const dbService = { db: drizzle({ client: sqlite }) };

    server = {
      id: SERVER_ID,
      type: 'FABRIC',
      mc_version: '1.21.1',
      env: {},
      disk_quota_bytes: 0,
    };
    const pathGuard = new PathGuardService({ dataDir } as never);
    const events = { recordEvent: jest.fn() };
    const indexer = {
      assertUnderQuota: jest.fn(() => Promise.resolve()),
      scan: jest.fn(() => Promise.resolve()),
      diskFree: () => Promise.resolve({ free: 1024 ** 4 }),
    };
    const serverEnv = { ensureOwnership: jest.fn(() => Promise.resolve()) };
    const query = {
      getServer: (id: string) =>
        Promise.resolve(id === SERVER_ID ? server : undefined),
    };

    library = new LibraryService(
      dbService as never,
      pathGuard,
      events as never,
      indexer as never,
      serverEnv as never,
    );
    const mods = new ModsService(
      dbService as never,
      pathGuard,
      indexer as never,
      events as never,
      library,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      query as never,
      {} as never,
      {} as never,
      {} as never,
    );

    knownModrinth = new Map();
    modrinth = {
      getVersionsByHashes: jest.fn((hashes: string[]) =>
        Promise.resolve(
          new Map(
            hashes.flatMap((h) => {
              const v = knownModrinth.get(h);
              return v ? [[h, v] as const] : [];
            }),
          ),
        ),
      ),
      getProjects: jest.fn((ids: string[]) =>
        Promise.resolve(
          new Map<string, ModrinthProject>(
            ids.map((id) => [
              id,
              {
                id,
                slug: `${id}-slug`,
                title: `${id} title`,
                icon_url: null,
                project_type: 'mod',
              },
            ]),
          ),
        ),
      ),
    };
    const curseforge = {
      getFingerprintMatches: () =>
        Promise.reject(new PreconditionFailedException('no key')),
    };
    const identifier = new JarIdentifierService(
      modrinth as never,
      curseforge as never,
    );
    overrides = new PackOverridesService(
      dbService as never,
      pathGuard,
      indexer as never,
      serverEnv as never,
    );
    service = new ContentImportService(
      dbService as never,
      pathGuard,
      indexer as never,
      events as never,
      library,
      query as never,
      identifier,
      mods,
      overrides,
    );

    downloads = new Map();
    jest.spyOn(global, 'fetch').mockImplementation((input) => {
      const body = downloads.get(
        input instanceof Request ? input.url : input.toString(),
      );
      return Promise.resolve(
        body ? fakeResponse(body) : new Response(null, { status: 404 }),
      );
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    sqlite.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('plain jar zip', () => {
    it('installs fitting jars as import-owned overlay rows and skips the rest', async () => {
      put('mods/already.jar', 'user jar');
      const report = await run({
        'mods/good.jar': fabricJar('good'),
        'mods/forgeonly.jar': forgeJar('forgeonly'),
        'plugins/perm.jar': pluginJar('Perm'),
        'nested/dir/good.jar': fabricJar('good-copy'),
        'mods/already.jar': fabricJar('already'),
        'overrides/mods/extra.jar': fabricJar('extra'),
        'overrides/config/good.toml': 'from pack',
        '__MACOSX/mods/._good.jar': 'junk',
      });

      expect(report.pack).toMatchObject({ format: 'jars', name: 'pack' });
      expect(
        report.installed.map((i) => [i.filename, i.origin, i.source]),
      ).toEqual([
        ['good.jar', 'bundled', 'metadata'],
        ['extra.jar', 'bundled', 'metadata'],
      ]);
      expect(report.skipped.map((s) => [s.path, s.reason]).sort()).toEqual(
        [
          ['mods/already.jar', 'already-installed'],
          ['mods/forgeonly.jar', 'wrong-loader'],
          ['nested/dir/good.jar', 'duplicate'],
          ['plugins/perm.jar', 'wrong-kind'],
        ].sort(),
      );
      expect(report.overrides).toEqual({
        applied: true,
        written: [{ path: 'config/good.toml', action: 'created' }],
        skipped: [],
      });

      // Files, rows and the import all line up.
      expect(read('mods/already.jar')).toBe('user jar');
      expect(fs.existsSync(serverFile('mods/good.jar'))).toBe(true);
      expect(fs.existsSync(serverFile('mods/extra.jar'))).toBe(true);
      expect(fs.existsSync(serverFile('config/mods'))).toBe(false);
      expect(read('config/good.toml')).toBe('from pack');
      const imp = report.import!;
      expect(imp).toMatchObject({
        format: 'jars',
        contentCount: 2,
        overrideCount: 1,
        actor: 'tester',
      });
      expect(
        rows('server_content').map((r) => [
          r.filename,
          r.import_id,
          r.managed_by,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ['good.jar', imp.id, 'overlay'],
          ['extra.jar', imp.id, 'overlay'],
        ]),
      );

      // Identification ran once for the whole pack, not per jar.
      expect(modrinth.getVersionsByHashes).toHaveBeenCalledTimes(1);
      const [hashes] = modrinth.getVersionsByHashes.mock.calls[0] as [string[]];
      expect(hashes).toHaveLength(4);

      // The staging copy is gone.
      expect(
        fs
          .readdirSync(path.join(dataDir, 'tmp'))
          .filter((f) => f.startsWith('import-')),
      ).toEqual([]);
    });

    it('gives a registry-identified jar its provenance in the library', async () => {
      const jar = fabricJar('sodium');
      knownModrinth.set(sha('sha1', jar), {
        id: 'ver1',
        project_id: 'AANobbMI',
        name: 'Sodium 0.6',
        version_number: '0.6.0',
        game_versions: ['1.21.1'],
        loaders: ['fabric'],
        files: [],
      });
      const report = await run({ 'sodium.jar': jar });
      expect(report.installed[0]).toMatchObject({
        source: 'modrinth',
        platform: 'modrinth',
        projectId: 'AANobbMI',
        name: 'AANobbMI title',
        version: '0.6.0',
      });
      const [lib] = rows('library_files');
      expect(lib).toMatchObject({
        platform: 'modrinth',
        project_id: 'AANobbMI',
        file_id: 'ver1',
        loaders_json: '["fabric"]',
      });
    });

    it('drops the import row when nothing was installed or written', async () => {
      const report = await run({ 'forge.jar': forgeJar('f') });
      expect(report.import).toBeNull();
      expect(report.skipped[0]!.reason).toBe('wrong-loader');
      expect(rows('content_imports')).toEqual([]);
    });

    it('lists override files but writes none when overrides are turned off', async () => {
      const report = await run(
        { 'a.jar': fabricJar('a'), 'overrides/config/a.toml': 'x' },
        { applyOverrides: false },
      );
      expect(report.overrides).toEqual({
        applied: false,
        written: [],
        skipped: [{ path: 'config/a.toml', reason: 'disabled' }],
      });
      expect(fs.existsSync(serverFile('config/a.toml'))).toBe(false);
    });

    it('refuses a packwiz server before touching anything', async () => {
      server.type = 'PACKWIZ';
      await expect(run({ 'a.jar': fabricJar('a') })).rejects.toThrow(/packwiz/);
    });

    it('rejects an archive with nothing importable', async () => {
      await expect(run({ 'readme.txt': 'hi' })).rejects.toThrow(
        BadRequestException,
      );
      expect(rows('content_imports')).toEqual([]);
    });
  });

  describe('.mrpack', () => {
    const good = fabricJar('lithium');
    const tampered = fabricJar('tampered');
    const url = (n: string) => `https://cdn.example/${n}`;
    const index = () =>
      JSON.stringify({
        formatVersion: 1,
        game: 'minecraft',
        versionId: '3.1',
        name: 'Cozy Pack',
        dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.5' },
        files: [
          {
            path: 'mods/lithium.jar',
            hashes: { sha1: sha('sha1', good), sha512: sha('sha512', good) },
            // First mirror is dead: the second one is used.
            downloads: [url('dead.jar'), url('lithium.jar')],
            env: { client: 'required', server: 'required' },
          },
          {
            path: 'mods/tampered.jar',
            hashes: { sha1: 'c'.repeat(40), sha512: 'd'.repeat(128) },
            downloads: [url('tampered.jar')],
          },
          {
            path: 'mods/zoomify.jar',
            hashes: { sha1: 'e'.repeat(40) },
            downloads: [url('zoomify.jar')],
            env: { client: 'required', server: 'unsupported' },
          },
          {
            path: 'resourcepacks/faithful.zip',
            hashes: { sha1: 'f'.repeat(40) },
            downloads: [url('faithful.zip')],
          },
        ],
      });

    beforeEach(() => {
      downloads.set(url('lithium.jar'), good);
      downloads.set(url('tampered.jar'), tampered);
      knownModrinth.set(sha('sha1', good), {
        id: 'lithver',
        project_id: 'gvQqBUqZ',
        name: 'Lithium',
        version_number: '0.14.0',
        game_versions: ['1.21.1'],
        loaders: ['fabric'],
        files: [],
      });
    });

    it('downloads, verifies and identifies index files; applies both override trees', async () => {
      put('config/shared.toml', 'original');
      const report = await run(
        {
          'modrinth.index.json': index(),
          'overrides/config/shared.toml': 'overrides copy',
          'server-overrides/config/shared.toml': 'server copy',
          'overrides/config/new.toml': 'new file',
          'client-overrides/options.txt': 'client only',
          'overrides/mods/bundled.jar': fabricJar('bundled'),
        },
        {},
        'cozy.mrpack',
      );

      expect(report.pack).toEqual({
        format: 'mrpack',
        name: 'Cozy Pack',
        version: '3.1',
        mcVersion: '1.21.1',
        loader: 'fabric',
        loaderVersion: '0.16.5',
      });
      expect(report.warnings).toEqual([]);
      expect(
        report.installed.map((i) => [i.filename, i.origin, i.source]),
      ).toEqual([
        ['bundled.jar', 'bundled', 'metadata'],
        ['lithium.jar', 'download', 'modrinth'],
      ]);
      expect(report.failed.map((f) => f.path)).toEqual(['mods/tampered.jar']);
      expect(report.failed[0]!.error).toMatch(/checksum mismatch/i);
      expect(report.skipped.map((s) => [s.path, s.reason])).toEqual([
        ['mods/zoomify.jar', 'client-only'],
        ['resourcepacks/faithful.zip', 'not-a-mod'],
      ]);
      expect(report.overrides.written).toEqual([
        { path: 'config/new.toml', action: 'created' },
        { path: 'config/shared.toml', action: 'replaced' },
      ]);
      expect(read('config/shared.toml')).toBe('server copy');
      expect(fs.existsSync(serverFile('options.txt'))).toBe(false);
      expect(
        fs.readFileSync(
          serverFile(`.import-backups/${report.import!.id}/config/shared.toml`),
          'utf8',
        ),
      ).toBe('original');

      const lib = rows('library_files').find(
        (r) => r.filename === 'lithium.jar',
      );
      expect(lib).toMatchObject({
        platform: 'modrinth',
        project_id: 'gvQqBUqZ',
        source_url: url('lithium.jar'),
      });
    });

    it('warns when the pack targets a different game version or loader', async () => {
      server.type = 'QUILT';
      server.mc_version = '1.20.1';
      const report = await run({ 'modrinth.index.json': index() });
      expect(report.warnings).toEqual([
        'The pack targets Minecraft 1.21.1; this server runs 1.20.1',
        'The pack targets fabric; this server runs quilt',
      ]);
      // Quilt loads Fabric mods, so the jar still installs.
      expect(report.installed.map((i) => i.filename)).toEqual(['lithium.jar']);
    });
  });

  describe('removal and override reversibility', () => {
    it('removes the jars and puts every override file back the way it was', async () => {
      put('config/replaced.toml', 'original');
      const report = await run({
        'a.jar': fabricJar('a'),
        'overrides/config/replaced.toml': 'pack version',
        'overrides/config/deep/created.toml': 'pack only',
        'overrides/config/edited.toml': 'pack only too',
      });
      const importId = report.import!.id;
      expect(rows('content_import_overrides')).toHaveLength(3);

      // The user edits one of the pack's files after the import.
      put('config/edited.toml', 'my edit');

      const removal = await service.remove(SERVER_ID, importId, {
        actor: 'tester',
      });
      expect(removal).toEqual({
        removedContent: ['a.jar'],
        overrides: {
          restored: ['config/replaced.toml'],
          deleted: ['config/deep/created.toml'],
          kept: ['config/edited.toml'],
        },
      });
      expect(read('config/replaced.toml')).toBe('original');
      expect(read('config/edited.toml')).toBe('my edit');
      expect(fs.existsSync(serverFile('config/deep'))).toBe(false); // pruned
      expect(fs.existsSync(serverFile('config'))).toBe(true); // still has files
      expect(fs.existsSync(serverFile('mods/a.jar'))).toBe(false);
      expect(fs.existsSync(serverFile('.import-backups'))).toBe(false);
      expect(rows('content_imports')).toEqual([]);
      expect(rows('content_import_overrides')).toEqual([]);
      expect(rows('server_content')).toEqual([]);
    });

    it('lets a later import stack on an earlier one and unwinds in either order', async () => {
      put('config/a.toml', 'original');
      const first = await run({ 'overrides/config/a.toml': 'first' });
      const second = await run({ 'overrides/config/a.toml': 'second' });
      expect(second.overrides.written).toEqual([
        { path: 'config/a.toml', action: 'replaced' },
      ]);
      // Removing the first while the second's content is live leaves it alone.
      const r1 = await service.remove(SERVER_ID, first.import!.id);
      expect(r1.overrides.kept).toEqual(['config/a.toml']);
      expect(read('config/a.toml')).toBe('second');
      // Removing the second restores what it replaced: the first's content.
      await service.remove(SERVER_ID, second.import!.id);
      expect(read('config/a.toml')).toBe('first');
    });

    it('leaves a deleted pack file deleted and still cleans up', async () => {
      const report = await run({ 'overrides/config/x.toml': 'x' });
      fs.rmSync(serverFile('config/x.toml'));
      const removal = await service.remove(SERVER_ID, report.import!.id);
      expect(removal.overrides.kept).toEqual(['config/x.toml']);
      expect(rows('content_import_overrides')).toEqual([]);
    });

    it('404s an unknown import or another server’s import', async () => {
      await expect(service.remove(SERVER_ID, 'imp_nope')).rejects.toThrow(
        /not found/,
      );
      const report = await run({ 'overrides/a.txt': 'x' });
      await expect(
        service.remove('other-server', report.import!.id),
      ).rejects.toThrow(/not found/);
    });

    it('lists imports with their live counts', async () => {
      const report = await run({
        'a.jar': fabricJar('a'),
        'overrides/a.txt': 'x',
      });
      expect(await service.list(SERVER_ID)).toEqual([report.import]);
      expect(await service.list('other-server')).toEqual([]);
    });
  });

  describe('path guard', () => {
    it('rejects a zip-slip entry before anything is written', async () => {
      await expect(
        run({
          'a.jar': fabricJar('a'),
          'overrides/../../../../escape.txt': 'pwned',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(fs.existsSync(path.join(root, 'escape.txt'))).toBe(false);
      expect(fs.existsSync(path.join(dataDir, 'escape.txt'))).toBe(false);
      expect(rows('content_imports')).toEqual([]);
      expect(rows('server_content')).toEqual([]);
    });

    it('rejects an absolute-path or backslash entry', async () => {
      await expect(run({ '/etc/evil.txt': 'x' })).rejects.toThrow(
        BadRequestException,
      );
      await expect(run({ 'overrides\\..\\..\\evil.txt': 'x' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('will not follow a symlink in the server dir out of it, and rolls back', async () => {
      const outside = path.join(root, 'outside');
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, serverFile('config'));
      const report = await run({
        'overrides/a.txt': 'first write',
        'overrides/config/evil.toml': 'pwned',
      });
      expect(fs.existsSync(path.join(outside, 'evil.toml'))).toBe(false);
      // a.txt was written before the escape was refused, then reverted.
      expect(fs.existsSync(serverFile('a.txt'))).toBe(false);
      expect(report.overrides.applied).toBe(false);
      expect(report.warnings[0]).toMatch(/not applied/);
      expect(report.import).toBeNull();
      expect(rows('content_import_overrides')).toEqual([]);
    });

    it('never writes into the backup tree', async () => {
      const report = await run({
        'overrides/.import-backups/imp_x/config/a.toml': 'forged backup',
        'overrides/b.txt': 'b',
      });
      expect(report.overrides.skipped).toEqual([
        { path: '.import-backups/imp_x/config/a.toml', reason: 'reserved' },
      ]);
      expect(fs.existsSync(serverFile('.import-backups/imp_x'))).toBe(false);
    });

    it('skips a path where a directory sits on the server', async () => {
      fs.mkdirSync(serverFile('config/thing'), { recursive: true });
      const report = await run({ 'overrides/config/thing': 'file' });
      expect(report.overrides.skipped).toEqual([
        { path: 'config/thing', reason: 'not-a-file' },
      ]);
    });
  });
});

describe('jarMisfit', () => {
  const jar = (kind: 'mod' | 'plugin' | null, loaders: string[]) => ({
    kind,
    loaders,
  });
  it('lets unknown or loader-less jars through', () => {
    expect(jarMisfit(jar(null, []), 'mod', 'fabric')).toBeNull();
    expect(jarMisfit(jar('mod', []), 'mod', 'fabric')).toBeNull();
    expect(jarMisfit(jar('mod', ['forge']), 'mod', null)).toBeNull();
  });
  it('matches loaders, with Fabric jars fitting Quilt', () => {
    expect(jarMisfit(jar('mod', ['fabric']), 'mod', 'quilt')).toBeNull();
    expect(jarMisfit(jar('mod', ['quilt']), 'mod', 'fabric')?.reason).toBe(
      'wrong-loader',
    );
    expect(
      jarMisfit(jar('mod', ['neoforge', 'forge']), 'mod', 'forge'),
    ).toBeNull();
  });
  it('keeps plugins and mods apart', () => {
    expect(jarMisfit(jar('plugin', ['paper']), 'mod', 'fabric')?.reason).toBe(
      'wrong-kind',
    );
    expect(jarMisfit(jar('mod', ['fabric']), 'plugin', 'paper')?.reason).toBe(
      'wrong-kind',
    );
    expect(jarMisfit(jar('plugin', ['paper']), 'plugin', 'paper')).toBeNull();
  });
});
