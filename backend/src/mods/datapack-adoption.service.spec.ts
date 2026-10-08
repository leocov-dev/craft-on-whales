import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SQLiteDialect } from 'drizzle-orm/sqlite-core';
import type { SQL } from 'drizzle-orm';
import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '../config/config.service';
import { PathGuardService } from '../storage/path-guard.service';
import { buildZipFixture } from '../utils/zip-fixture.test-helpers';
import { DatapackAdoptionService } from './datapack-adoption.service';
import {
  DatapackIconService,
  MAX_ICON_BYTES,
  MAX_SCANNED_ENTRIES,
} from './datapack-icon.service';
import { DatapacksService } from './datapacks.service';
import type { IdentifiedJar, JarInput } from './mods.types';

const SERVER = 'srv1';
const dialect = new SQLiteDialect();

interface Row {
  id: string;
  serverId: string;
  libraryId: string | null;
  kind: string;
  managedBy: string;
  name: string;
  filename: string;
  version: string | null;
  iconUrl: string | null;
  iconRelPath: string | null;
  enabled: boolean;
}

/** Evaluate a drizzle `and(eq(..), inArray(..))` condition against a row (see datapacks.service.spec.ts). */
function matches(row: Row, where: SQL): boolean {
  const { sql, params } = dialect.sqlToQuery(where);
  const snake: Record<string, keyof Row> = {
    id: 'id',
    server_id: 'serverId',
    kind: 'kind',
    filename: 'filename',
  };
  let next = 0;
  const clauses = [
    ...sql.matchAll(/"(\w+)"\s*(=|in)\s*(\?|\((?:\?,?\s*)+\))/g),
  ];
  if (clauses.length === 0) throw new Error(`unparsed where: ${sql}`);
  return clauses.every(([, col, op, rhs]) => {
    const key = snake[col!];
    if (!key) throw new Error(`unknown column ${col} in: ${sql}`);
    const n = op === '=' ? 1 : (rhs!.match(/\?/g) ?? []).length;
    const values = params.slice(next, next + n);
    next += n;
    return values.includes(row[key]);
  });
}

/** A minimal valid PNG header (signature + IHDR), `size` x `size`, padded to `total` bytes. */
function png(size = 64, total = 64): Buffer {
  const buf = Buffer.alloc(total);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(size, 16);
  buf.writeUInt32BE(size, 20);
  return buf;
}

const mcmeta = (d: string) =>
  JSON.stringify({ pack: { description: d, pack_format: 48 } });

describe('DatapackAdoptionService', () => {
  let root: string;
  let rows: Row[];
  let env: Record<string, string>;
  let identify: jest.Mock<Promise<IdentifiedJar[]>, [JarInput[]]>;
  let registry: Record<string, Partial<IdentifiedJar>>;
  let importFile: jest.Mock;
  let getLibraryFiles: jest.Mock;
  let failInsert: boolean;
  let svc: DatapackAdoptionService;
  let packs: DatapacksService;

  const serverDir = () => path.join(root, 'servers', SERVER);
  const put = (rel: string, content: Buffer | string = 'x') => {
    const abs = path.join(serverDir(), rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  const exists = (rel: string) => fs.existsSync(path.join(serverDir(), rel));
  const zip = (files: Record<string, string | Buffer>) =>
    buildZipFixture(
      Object.entries(files).map(([name, content]) => ({ name, content })),
    );
  const row = (over: Partial<Row>): Row => ({
    id: 'sc_exist',
    serverId: SERVER,
    libraryId: null,
    kind: 'datapack',
    managedBy: 'overlay',
    name: 'Custom',
    filename: 'a.zip',
    version: '1.0',
    iconUrl: 'https://x/i.png',
    iconRelPath: null,
    enabled: true,
    ...over,
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-adopt-'));
    fs.mkdirSync(serverDir(), { recursive: true });
    rows = [];
    failInsert = false;
    env = {};
    registry = {};
    const pathGuard = new PathGuardService({ dataDir: root } as ConfigService);
    const db = {
      select: () => ({
        from: () => ({
          where: (w: SQL) => Promise.resolve(rows.filter((r) => matches(r, w))),
        }),
      }),
      insert: () => ({
        values: (v: Row) => ({
          onConflictDoNothing: () => ({
            returning: () => {
              if (failInsert) return Promise.reject(new Error('db down'));
              if (
                rows.some(
                  (r) => r.serverId === v.serverId && r.filename === v.filename,
                )
              )
                return Promise.resolve([]);
              rows.push({ ...v });
              return Promise.resolve([{ id: v.id }]);
            },
          }),
        }),
      }),
      update: () => ({
        set: (v: Partial<Row>) => ({
          where: (w: SQL) => {
            for (const r of rows) if (matches(r, w)) Object.assign(r, v);
            return Promise.resolve();
          },
        }),
      }),
      delete: () => ({
        where: (w: SQL) => ({
          returning: () => {
            const gone = rows.filter((r) => matches(r, w));
            rows = rows.filter((r) => !gone.includes(r));
            return Promise.resolve(gone.map((r) => ({ ...r })));
          },
        }),
      }),
    };
    const query = {
      getServer: () => Promise.resolve({ id: SERVER, type: 'VANILLA', env }),
    };
    const icons = new DatapackIconService(pathGuard);
    packs = new DatapacksService(
      { db } as never,
      pathGuard,
      { get: () => undefined } as never,
      query as never,
      {
        getLibraryFile: () => Promise.resolve(undefined),
        usageCount: () => Promise.resolve(0),
      } as never,
      { recordEvent: () => undefined } as never,
      icons,
    );
    identify = jest.fn((jars: JarInput[]) =>
      Promise.resolve(
        jars.map(
          (j) =>
            ({
              filename: j.filename,
              source: 'unknown',
              platform: null,
              projectId: null,
              ...registry[j.filename],
            }) as IdentifiedJar,
        ),
      ),
    );
    importFile = jest.fn(() => Promise.resolve({ id: 'lib_1' }));
    getLibraryFiles = jest.fn((ids: string[]) =>
      Promise.resolve(
        new Map(
          ids
            .filter((id) => id === 'lib_1')
            .map((id) => [
              id,
              { id, projectId: 'P', iconUrl: 'https://x/i.png' },
            ]),
        ),
      ),
    );
    const library = {
      importFile,
      getLibraryFiles,
      fillMissingProvenance: () => Promise.resolve({ id: 'lib_1' }),
    };
    svc = new DatapackAdoptionService(
      { db } as never,
      query as never,
      packs,
      { identifyMany: identify } as never,
      library as never,
      icons,
      { recordEvent: () => undefined } as never,
    );
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const hit = (over: Partial<IdentifiedJar> = {}): Partial<IdentifiedJar> => ({
    source: 'modrinth',
    platform: 'modrinth',
    projectId: 'P',
    versionId: 'V',
    name: 'Pretty Pack',
    version: '2.1',
    iconUrl: 'https://x/i.png',
    ...over,
  });

  it('adopts zip and dir orphans from both dirs, enabled per location, without moving them', async () => {
    put('world/datapacks/on.zip', zip({ 'pack.mcmeta': mcmeta('on') }));
    put('world/datapacks/dirpack/pack.mcmeta', mcmeta('dir'));
    put(
      'world/datapacks.disabled/off.zip',
      zip({ 'pack.mcmeta': mcmeta('o') }),
    );
    put('world/datapacks.disabled/offdir/pack.mcmeta', mcmeta('d'));
    put(
      'world/datapacks/legacy.zip.disabled',
      zip({ 'pack.mcmeta': mcmeta('l') }),
    );

    const report = await svc.adoptAndRepair(SERVER);

    expect(report).toMatchObject({ adopted: 5, repaired: 0, failed: 0 });
    const by = Object.fromEntries(rows.map((r) => [r.filename, r]));
    expect(Object.keys(by).sort()).toEqual([
      'dirpack',
      'legacy.zip',
      'off.zip',
      'offdir',
      'on.zip',
    ]);
    expect(rows.every((r) => r.managedBy === 'overlay')).toBe(true);
    expect(rows.every((r) => r.kind === 'datapack')).toBe(true);
    expect(by['on.zip']!.enabled).toBe(true);
    expect(by['dirpack']!.enabled).toBe(true);
    expect(by['off.zip']!.enabled).toBe(false);
    expect(by['offdir']!.enabled).toBe(false);
    expect(by['legacy.zip']!.enabled).toBe(false);
    expect(exists('world/datapacks/on.zip')).toBe(true);
    expect(exists('world/datapacks.disabled/off.zip')).toBe(true);
    expect(exists('world/datapacks/legacy.zip.disabled')).toBe(true);
  });

  it('uses a registry match for name, version, icon and a hard-linked library row', async () => {
    put('world/datapacks/a.zip', zip({ 'pack.mcmeta': mcmeta('a') }));
    registry['a.zip'] = hit();

    const report = await svc.adoptAndRepair(SERVER);

    expect(report.details[0]).toMatchObject({
      outcome: 'adopted',
      source: 'modrinth',
      fields: ['library', 'icon'],
    });
    expect(rows[0]).toMatchObject({
      name: 'Pretty Pack',
      version: '2.1',
      iconUrl: 'https://x/i.png',
      libraryId: 'lib_1',
    });
    expect(importFile).toHaveBeenCalledWith(
      path.join(serverDir(), 'world/datapacks/a.zip'),
      expect.objectContaining({ category: 'datapack' }),
      { hardlink: true, actor: 'system' },
    );
  });

  it('adopts by metadata only when the registries find nothing or are down', async () => {
    put(
      'world/datapacks/some-pack_v2.zip',
      zip({ 'pack.mcmeta': mcmeta('a') }),
    );
    identify.mockRejectedValueOnce(new Error('boom'));

    const report = await svc.adoptAndRepair(SERVER);

    expect(report).toMatchObject({ adopted: 1, failed: 0 });
    expect(rows[0]).toMatchObject({
      name: 'some pack v2',
      version: null,
      libraryId: null,
    });
    expect(report.details[0]).toMatchObject({ source: 'metadata' });
    expect(importFile).not.toHaveBeenCalled();
  });

  it('does not hash directory packs', async () => {
    put('world/datapacks/dirpack/pack.mcmeta', mcmeta('d'));
    await svc.adoptAndRepair(SERVER);
    expect(identify).not.toHaveBeenCalled();
  });

  it('is idempotent: a complete second run changes nothing and does no lookups', async () => {
    put('world/datapacks/a.zip', zip({ 'pack.mcmeta': mcmeta('a') }));
    registry['a.zip'] = hit();
    await svc.adoptAndRepair(SERVER);
    const snapshot = JSON.stringify(rows);
    identify.mockClear();

    const again = await svc.adoptAndRepair(SERVER);

    expect(again).toMatchObject({
      adopted: 0,
      repaired: 0,
      skipped: 0,
      failed: 0,
      details: [],
    });
    expect(identify).not.toHaveBeenCalled();
    expect(JSON.stringify(rows)).toBe(snapshot);
  });

  it('leaves complete, already-adopted rows alone', async () => {
    put('world/datapacks/a.zip', zip({ 'pack.mcmeta': mcmeta('a') }));
    rows.push(row({}));
    const before = JSON.stringify(rows);

    const report = await svc.adoptAndRepair(SERVER);

    expect(report.details).toEqual([]);
    expect(identify).not.toHaveBeenCalled();
    expect(JSON.stringify(rows)).toBe(before);
  });

  it('repair fills only missing fields and never overwrites set ones', async () => {
    put('world/datapacks/a.zip', zip({ 'pack.mcmeta': mcmeta('a') }));
    rows.push(row({ name: 'My Name', version: null, iconUrl: null }));
    registry['a.zip'] = hit({ name: 'Registry Name', version: '9.9' });

    const report = await svc.adoptAndRepair(SERVER);

    expect(report).toMatchObject({ repaired: 1 });
    expect(rows[0]).toMatchObject({
      name: 'My Name',
      version: '9.9',
      iconUrl: 'https://x/i.png',
      libraryId: 'lib_1',
    });
  });

  it('repair replaces a fallback name but not a custom one', async () => {
    put('world/datapacks/some-pack.zip', zip({ 'pack.mcmeta': mcmeta('a') }));
    rows.push(row({ filename: 'some-pack.zip', name: 'some pack' }));
    registry['some-pack.zip'] = hit({ name: 'Real Name' });
    await svc.adoptAndRepair(SERVER);
    expect(rows[0]!.name).toBe('Real Name');
  });

  it('skips pack-managed rows', async () => {
    put('world/datapacks/a.zip', zip({ 'pack.mcmeta': mcmeta('a') }));
    rows.push(
      row({ managedBy: 'pack', version: null, name: 'a', iconUrl: null }),
    );
    const report = await svc.adoptAndRepair(SERVER);
    expect(report.details).toEqual([]);
    expect(identify).not.toHaveBeenCalled();
  });

  it('attributes the library import to the acting user', async () => {
    put('world/datapacks/a.zip', zip({ 'pack.mcmeta': mcmeta('a') }));
    registry['a.zip'] = hit();
    await svc.adoptAndRepair(SERVER, { actor: 'alice' });
    expect(importFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      { hardlink: true, actor: 'alice' },
    );
  });

  it('identifies zips in batches of at most 4', async () => {
    for (let i = 0; i < 6; i++)
      put(`world/datapacks/p${i}.zip`, zip({ 'pack.mcmeta': mcmeta('a') }));
    await svc.adoptAndRepair(SERVER);
    expect(identify.mock.calls.map(([jars]) => jars.length)).toEqual([4, 2]);
  });

  it('looks library rows up in one query, not one per row', async () => {
    for (let i = 0; i < 3; i++) {
      put(`world/datapacks/p${i}.zip`, zip({ 'pack.mcmeta': mcmeta('a') }));
      rows.push(
        row({
          id: `sc_${i}`,
          filename: `p${i}.zip`,
          libraryId: 'lib_1',
          iconUrl: null,
        }),
      );
    }
    await svc.adoptAndRepair(SERVER);
    expect(getLibraryFiles).toHaveBeenCalledTimes(1);
  });

  it('does not re-examine a directory pack that has an icon but no version', async () => {
    put('world/datapacks/d/pack.mcmeta', mcmeta('d'));
    rows.push(row({ filename: 'd', version: null }));
    const report = await svc.adoptAndRepair(SERVER);
    expect(report.details).toEqual([]);
  });

  it('does not re-examine a zip whose library row already has provenance', async () => {
    put('world/datapacks/a.zip', zip({ 'pack.mcmeta': mcmeta('a') }));
    rows.push(row({ version: null, libraryId: 'lib_1', iconUrl: null }));
    const report = await svc.adoptAndRepair(SERVER);
    expect(report.details).toEqual([]);
    expect(identify).not.toHaveBeenCalled();
  });

  it('reports a pack swapped for a symlink after the scan as failed, reading nothing', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'e.zip'), 'secret');
      const link = path.join(serverDir(), 'world/datapacks/a.zip');
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(path.join(outside, 'e.zip'), link);
      jest.spyOn(packs, 'diskPacks').mockResolvedValue([
        {
          file: 'a.zip',
          diskName: 'a.zip',
          abs: link,
          isDirectory: false,
          enabled: true,
          size: 6,
        },
      ] as never);
      registry['a.zip'] = hit();

      const report = await svc.adoptAndRepair(SERVER);

      expect(report).toMatchObject({ adopted: 0, failed: 1 });
      expect(importFile).not.toHaveBeenCalled();
      expect(rows).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('removes the extracted icon when the row insert throws', async () => {
    put(
      'world/datapacks/a.zip',
      zip({ 'pack.mcmeta': mcmeta('a'), 'pack.png': png() }),
    );
    failInsert = true;
    const report = await svc.adoptAndRepair(SERVER);
    expect(report).toMatchObject({ adopted: 0, failed: 1 });
    const dir = path.join(root, 'library/icons/mods');
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  describe('pack.png', () => {
    it('extracts a valid icon from a dir and from a zip', async () => {
      put('world/datapacks/d/pack.mcmeta', mcmeta('d'));
      put('world/datapacks/d/pack.png', png());
      put(
        'world/datapacks/z.zip',
        zip({ 'pack.mcmeta': mcmeta('z'), 'pack.png': png() }),
      );

      const report = await svc.adoptAndRepair(SERVER);

      expect(report.adopted).toBe(2);
      for (const r of rows) {
        expect(r.iconRelPath).toBe(`library/icons/mods/lib_dp_${r.id}.png`);
        expect(fs.readFileSync(path.join(root, r.iconRelPath!))).toEqual(png());
      }
    });

    it('rejects a bad signature and an oversized icon', async () => {
      const bad = png();
      bad[0] = 0;
      put('world/datapacks/bad/pack.mcmeta', mcmeta('d'));
      put('world/datapacks/bad/pack.png', bad);
      put('world/datapacks/big/pack.mcmeta', mcmeta('d'));
      put('world/datapacks/big/pack.png', png(64, MAX_ICON_BYTES + 1));
      put(
        'world/datapacks/zbig.zip',
        zip({
          'pack.mcmeta': mcmeta('z'),
          'pack.png': png(64, MAX_ICON_BYTES + 1),
        }),
      );
      put(
        'world/datapacks/zbad.zip',
        zip({ 'pack.mcmeta': mcmeta('z'), 'pack.png': bad }),
      );

      await svc.adoptAndRepair(SERVER);

      expect(rows).toHaveLength(4);
      expect(rows.every((r) => r.iconRelPath === null)).toBe(true);
    });

    it('rejects an IHDR chunk whose length is not 13', async () => {
      const bad = png();
      bad.writeUInt32BE(14, 8);
      put('world/datapacks/bad/pack.mcmeta', mcmeta('d'));
      put('world/datapacks/bad/pack.png', bad);
      await svc.adoptAndRepair(SERVER);
      expect(rows[0]!.iconRelPath).toBeNull();
    });

    it('ignores pack.png in a zip with too many entries', async () => {
      const entries: Record<string, string | Buffer> = {};
      for (let i = 0; i < MAX_SCANNED_ENTRIES; i++) entries[`f${i}`] = '';
      entries['pack.png'] = png(); // past the cap
      put('world/datapacks/many.zip', zip(entries));
      await svc.adoptAndRepair(SERVER);
      expect(rows[0]!.iconRelPath).toBeNull();
    });

    it('does not follow a symlinked pack.png', async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
      try {
        fs.writeFileSync(path.join(outside, 'p.png'), png());
        put('world/datapacks/d/pack.mcmeta', mcmeta('d'));
        fs.symlinkSync(
          path.join(outside, 'p.png'),
          path.join(serverDir(), 'world/datapacks/d/pack.png'),
        );
        await svc.adoptAndRepair(SERVER);
        expect(rows[0]!.iconRelPath).toBeNull();
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('repair adds a missing icon from pack.png', async () => {
      put(
        'world/datapacks/a.zip',
        zip({ 'pack.mcmeta': mcmeta('a'), 'pack.png': png() }),
      );
      rows.push(row({ iconUrl: null }));

      const report = await svc.adoptAndRepair(SERVER);

      expect(report).toMatchObject({ repaired: 1 });
      expect(rows[0]!.iconRelPath).toBe(
        'library/icons/mods/lib_dp_sc_exist.png',
      );
    });
  });

  describe('safety', () => {
    it.each(['../etc', 'a/b', '..'])(
      'rejects hostile level name %j',
      async (level) => {
        env.LEVEL = level;
        await expect(svc.adoptAndRepair(SERVER)).rejects.toThrow(
          BadRequestException,
        );
        expect(rows).toEqual([]);
      },
    );

    it('skips symlinked entries', async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
      try {
        fs.mkdirSync(path.join(outside, 'p'));
        fs.writeFileSync(path.join(outside, 'p', 'pack.mcmeta'), mcmeta('x'));
        fs.writeFileSync(path.join(outside, 'e.zip'), 'x');
        fs.mkdirSync(path.join(serverDir(), 'world/datapacks'), {
          recursive: true,
        });
        fs.symlinkSync(
          path.join(outside, 'p'),
          path.join(serverDir(), 'world/datapacks/p'),
        );
        fs.symlinkSync(
          path.join(outside, 'e.zip'),
          path.join(serverDir(), 'world/datapacks/e.zip'),
        );
        const report = await svc.adoptAndRepair(SERVER);
        expect(report.adopted).toBe(0);
        expect(rows).toEqual([]);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('reports a pack in both dirs once', async () => {
      put('world/datapacks/a.zip', zip({ 'pack.mcmeta': mcmeta('a') }));
      put(
        'world/datapacks.disabled/a.zip',
        zip({ 'pack.mcmeta': mcmeta('a') }),
      );
      const report = await svc.adoptAndRepair(SERVER);
      expect(report).toMatchObject({ adopted: 1, skipped: 1 });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.enabled).toBe(true);
    });
  });

  it('an adopted pack toggles and removes through the phase 1 paths, icon included', async () => {
    put(
      'world/datapacks/a.zip',
      zip({ 'pack.mcmeta': mcmeta('a'), 'pack.png': png() }),
    );
    await svc.adoptAndRepair(SERVER);
    const iconRel = rows[0]!.iconRelPath!;

    await packs.setEnabled(SERVER, 'a.zip', false);
    expect(exists('world/datapacks.disabled/a.zip')).toBe(true);
    expect(rows[0]!.enabled).toBe(false);

    await packs.removeDatapack(SERVER, 'a.zip');
    expect(exists('world/datapacks.disabled/a.zip')).toBe(false);
    expect(rows).toEqual([]);
    expect(fs.existsSync(path.join(root, iconRel))).toBe(false);
  });
});
