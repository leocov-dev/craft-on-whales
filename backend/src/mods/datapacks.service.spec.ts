import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SQLiteDialect } from 'drizzle-orm/sqlite-core';
import type { SQL } from 'drizzle-orm';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '../config/config.service';
import { PathGuardService } from '../storage/path-guard.service';
import { buildZipFixture } from '../utils/zip-fixture.test-helpers';
import { DatapackIconService } from './datapack-icon.service';
import { DatapacksService, parsePackMeta } from './datapacks.service';

const SERVER = 'srv1';
const dialect = new SQLiteDialect();

/**
 * Evaluate a drizzle `and(eq(..), inArray(..))` condition against a row, so
 * the fake DB only touches rows the real query would. Renders the condition to
 * SQL and reads the `"col" = ?` / `"col" in (?, ?)` clauses back out.
 */
function matches(row: Row, where: SQL): boolean {
  const { sql, params } = dialect.sqlToQuery(where);
  const snake: Record<string, keyof Row> = {
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

interface Row {
  id: string;
  serverId: string;
  filename: string;
  kind: string;
  managedBy: string;
  name: string;
  version: string | null;
  iconUrl: string | null;
  libraryId: string | null;
  enabled: boolean;
}

const row = (over: Partial<Row>): Row => ({
  id: 'sc_1',
  serverId: SERVER,
  filename: 'a.zip',
  kind: 'datapack',
  managedBy: 'overlay',
  name: 'A',
  version: null,
  iconUrl: null,
  libraryId: null,
  enabled: true,
  ...over,
});

describe('DatapacksService', () => {
  let root: string;
  let props: Map<string, string>;
  let env: Record<string, string>;
  let rows: Row[];
  let svc: DatapacksService;

  const serverDir = () => path.join(root, 'servers', SERVER);
  const put = (rel: string, content: Buffer | string = 'x') => {
    const abs = path.join(serverDir(), rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };
  const exists = (rel: string) => fs.existsSync(path.join(serverDir(), rel));
  const mcmeta = (description: unknown, format = 48) =>
    JSON.stringify({ pack: { description, pack_format: format } });
  const zip = (files: Record<string, string>) =>
    buildZipFixture(
      Object.entries(files).map(([name, content]) => ({ name, content })),
    );

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'datapacks-'));
    fs.mkdirSync(serverDir(), { recursive: true });
    props = new Map();
    env = {};
    rows = [];
    const pathGuard = new PathGuardService({ dataDir: root } as ConfigService);
    const db = {
      select: () => ({
        from: () => ({
          where: (w: SQL) => Promise.resolve(rows.filter((r) => matches(r, w))),
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
            return Promise.resolve(gone.map((r) => ({ id: r.id })));
          },
        }),
      }),
    };
    svc = new DatapacksService(
      { db } as never,
      pathGuard,
      { get: (_id: string, k: string) => props.get(k) } as never,
      {
        getServer: () => Promise.resolve({ id: SERVER, type: 'VANILLA', env }),
      } as never,
      {
        getLibraryFile: () => Promise.resolve(undefined),
        usageCount: () => Promise.resolve(0),
      } as never,
      { recordEvent: () => undefined } as never,
      new DatapackIconService(pathGuard),
    );
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  describe('active world', () => {
    it('LEVEL env wins, then level-name, then world', () => {
      props.set('level-name', 'fromprops');
      expect(svc.activeDirRel({ id: SERVER, env: { LEVEL: 'fromenv' } })).toBe(
        'fromenv/datapacks',
      );
      expect(svc.activeDirRel({ id: SERVER, env: {} })).toBe(
        'fromprops/datapacks',
      );
      props.clear();
      expect(svc.activeDirRel({ id: SERVER, env: {} })).toBe('world/datapacks');
    });

    it('puts the disabled dir beside datapacks, not inside it', () => {
      expect(
        svc.disabledDirRel({ id: SERVER, env: { LEVEL: 'My World' } }),
      ).toBe('My World/datapacks.disabled');
    });

    it.each(['../etc', 'a/b', 'a\\b', '..', '.', 'a\0b'])(
      'rejects hostile level name %j',
      (level) => {
        expect(() =>
          svc.activeDirRel({ id: SERVER, env: { LEVEL: level } }),
        ).toThrow(BadRequestException);
        props.set('level-name', level);
        expect(() => svc.activeDirRel({ id: SERVER, env: {} })).toThrow(
          BadRequestException,
        );
      },
    );
  });

  describe('parsePackMeta', () => {
    it('reads string and text-component descriptions, tolerates junk', () => {
      expect(parsePackMeta(mcmeta('hi'))).toEqual({
        description: 'hi',
        packFormat: 48,
      });
      expect(
        parsePackMeta('\uFEFF' + mcmeta([{ text: 'a' }, { text: 'b' }], 9)),
      ).toEqual({ description: 'ab', packFormat: 9 });
      expect(parsePackMeta('not json')).toEqual({
        description: null,
        packFormat: null,
      });
    });
  });

  describe('listDatapacks', () => {
    it('lists zips and dirs from both dirs, with metadata', async () => {
      put(
        'world/datapacks/a.zip',
        zip({ 'pack.mcmeta': mcmeta('Zip pack', 15) }),
      );
      put('world/datapacks/dirpack/pack.mcmeta', mcmeta('Dir pack'));
      put('world/datapacks/dirpack/data/x.json', '12345');
      put('world/datapacks/notapack/readme.txt');
      put('world/datapacks/readme.txt');
      put(
        'world/datapacks.disabled/off.zip',
        zip({ 'pack.mcmeta': mcmeta('Off') }),
      );
      const items = await svc.listDatapacks(SERVER);
      const by = Object.fromEntries(items.map((i) => [i.file, i]));
      expect(Object.keys(by).sort()).toEqual(['a.zip', 'dirpack', 'off.zip']);
      expect(by['a.zip']).toMatchObject({
        kind: 'datapack',
        enabled: true,
        description: 'Zip pack',
        packFormat: 15,
        isDirectory: false,
      });
      expect(by['dirpack']).toMatchObject({
        enabled: true,
        isDirectory: true,
        description: 'Dir pack',
      });
      expect(by['dirpack']!.size).toBe(
        fs.statSync(
          path.join(serverDir(), 'world/datapacks/dirpack/pack.mcmeta'),
        ).size + 5,
      );
      expect(by['off.zip']).toMatchObject({ enabled: false });
    });

    it('uses the active level, not world', async () => {
      props.set('level-name', 'survival');
      put('world/datapacks/old.zip');
      put('survival/datapacks/new.zip');
      expect((await svc.listDatapacks(SERVER)).map((i) => i.file)).toEqual([
        'new.zip',
      ]);
    });

    it('treats legacy x.zip.disabled as a disabled x.zip', async () => {
      put('world/datapacks/old.zip.disabled');
      const [item] = await svc.listDatapacks(SERVER);
      expect(item).toMatchObject({ file: 'old.zip', enabled: false });
    });

    it('skips symlinks and does not count symlinked files in a dir size', async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
      try {
        fs.writeFileSync(path.join(outside, 'big.bin'), 'x'.repeat(1000));
        put('world/datapacks/p/pack.mcmeta', mcmeta('p'));
        fs.symlinkSync(
          outside,
          path.join(serverDir(), 'world/datapacks/p/link'),
        );
        fs.symlinkSync(
          path.join(outside, 'big.bin'),
          path.join(serverDir(), 'world/datapacks/evil.zip'),
        );
        fs.symlinkSync(
          outside,
          path.join(serverDir(), 'world/datapacks/evildir'),
        );
        const items = await svc.listDatapacks(SERVER);
        expect(items.map((i) => i.file)).toEqual(['p']);
        expect(items[0]!.size).toBe(
          fs.statSync(path.join(serverDir(), 'world/datapacks/p/pack.mcmeta'))
            .size,
        );
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('surfaces rows whose pack is gone as missing', async () => {
      rows.push(row({ filename: 'gone.zip', name: 'Gone', enabled: true }));
      const [item] = await svc.listDatapacks(SERVER);
      expect(item).toMatchObject({ file: 'gone.zip', missing: true });
    });
  });

  describe('setEnabled', () => {
    it('moves a pack out to datapacks.disabled and back, creating the dir', async () => {
      put('world/datapacks/a.zip');
      const other = row({ id: 'o1', filename: 'b.zip' });
      const otherServer = row({ id: 'o2', serverId: 'srv2' });
      const otherKind = row({ id: 'o3', kind: 'mod' });
      rows.push(row({ enabled: true }), other, otherServer, otherKind);
      await expect(svc.setEnabled(SERVER, 'a.zip', false)).resolves.toEqual({
        applied: 'on-restart',
      });
      expect(exists('world/datapacks/a.zip')).toBe(false);
      expect(exists('world/datapacks.disabled/a.zip')).toBe(true);
      expect(rows.map((r) => [r.id, r.enabled])).toEqual([
        ['sc_1', false],
        ['o1', true],
        ['o2', true],
        ['o3', true],
      ]);
      await svc.setEnabled(SERVER, 'a.zip', true);
      expect(exists('world/datapacks/a.zip')).toBe(true);
      expect(exists('world/datapacks.disabled/a.zip')).toBe(false);
    });

    it('moves a directory pack whole', async () => {
      put('world/datapacks/d/pack.mcmeta', mcmeta('d'));
      await svc.setEnabled(SERVER, 'd', false);
      expect(exists('world/datapacks.disabled/d/pack.mcmeta')).toBe(true);
      expect(exists('world/datapacks/d')).toBe(false);
    });

    it('is idempotent when already in the requested state', async () => {
      put('world/datapacks/a.zip');
      await svc.setEnabled(SERVER, 'a.zip', true);
      expect(exists('world/datapacks/a.zip')).toBe(true);
    });

    it('409s instead of overwriting at the destination', async () => {
      put('world/datapacks/a.zip', 'enabled');
      put('world/datapacks.disabled/a.zip', 'disabled');
      await expect(svc.setEnabled(SERVER, 'a.zip', false)).rejects.toThrow(
        ConflictException,
      );
      expect(
        fs.readFileSync(
          path.join(serverDir(), 'world/datapacks.disabled/a.zip'),
          'utf8',
        ),
      ).toBe('disabled');
      expect(exists('world/datapacks/a.zip')).toBe(true);
    });

    it('409s on a directory too, and keeps both', async () => {
      put('world/datapacks/d/pack.mcmeta', 'one');
      put('world/datapacks.disabled/d/pack.mcmeta', 'two');
      await expect(svc.setEnabled(SERVER, 'd', false)).rejects.toThrow(
        ConflictException,
      );
      expect(exists('world/datapacks/d/pack.mcmeta')).toBe(true);
      expect(exists('world/datapacks.disabled/d/pack.mcmeta')).toBe(true);
    });

    it('keeps the link-and-unlink move working when linking fails', async () => {
      put('world/datapacks/a.zip', 'x');
      const link = jest
        .spyOn(fs.promises, 'link')
        .mockRejectedValueOnce(
          Object.assign(new Error('xdev'), { code: 'EXDEV' }),
        );
      try {
        await svc.setEnabled(SERVER, 'a.zip', false);
        expect(link).toHaveBeenCalled();
        expect(exists('world/datapacks.disabled/a.zip')).toBe(true);
        expect(exists('world/datapacks/a.zip')).toBe(false);
      } finally {
        link.mockRestore();
      }
    });

    it('re-enables a legacy .disabled zip in place', async () => {
      put('world/datapacks/old.zip.disabled');
      await svc.setEnabled(SERVER, 'old.zip', true);
      expect(exists('world/datapacks/old.zip')).toBe(true);
      expect(exists('world/datapacks/old.zip.disabled')).toBe(false);
    });

    it('moves a legacy .disabled zip into the disabled dir on disable', async () => {
      put('world/datapacks/old.zip.disabled');
      await svc.setEnabled(SERVER, 'old.zip', false);
      expect(exists('world/datapacks.disabled/old.zip')).toBe(true);
      expect(exists('world/datapacks/old.zip.disabled')).toBe(false);
    });

    it('404s for an unknown pack and 400s for a path-ish name', async () => {
      await expect(svc.setEnabled(SERVER, 'nope.zip', false)).rejects.toThrow(
        NotFoundException,
      );
      await expect(svc.setEnabled(SERVER, '../x.zip', false)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('clearDisabledCopy', () => {
    it('removes disabled and legacy copies but leaves the enabled one', async () => {
      put('world/datapacks/a.zip', 'new');
      put('world/datapacks.disabled/a.zip');
      put('world/datapacks/a.zip.disabled');
      await svc.clearDisabledCopy({ id: SERVER, env } as never, 'a.zip');
      expect(exists('world/datapacks/a.zip')).toBe(true);
      expect(exists('world/datapacks.disabled/a.zip')).toBe(false);
      expect(exists('world/datapacks/a.zip.disabled')).toBe(false);
    });
  });

  describe('removeDatapack', () => {
    it('removes a file from either dir and drops its row', async () => {
      put('world/datapacks.disabled/a.zip', '12345');
      rows.push(row({ filename: 'a.zip', name: 'A', enabled: false }));
      await expect(svc.removeDatapack(SERVER, 'a.zip')).resolves.toEqual({
        freedBytes: 5,
      });
      expect(exists('world/datapacks.disabled/a.zip')).toBe(false);
      expect(rows).toHaveLength(0);
    });

    it('counts no freed bytes for a hard-linked pack (the library copy keeps them)', async () => {
      put('world/datapacks/a.zip', '12345');
      fs.linkSync(
        path.join(serverDir(), 'world/datapacks/a.zip'),
        path.join(serverDir(), 'library-copy.zip'),
      );
      rows.push(row({ libraryId: 'lib_1' }));
      await expect(svc.removeDatapack(SERVER, 'a.zip')).resolves.toEqual({
        freedBytes: 0,
      });
      expect(exists('world/datapacks/a.zip')).toBe(false);
      expect(exists('library-copy.zip')).toBe(true);
    });

    it('only drops the matching row, not other files, servers or kinds', async () => {
      put('world/datapacks/a.zip');
      rows.push(
        row({ id: 'keep1', filename: 'b.zip' }),
        row({ id: 'keep2', serverId: 'srv2' }),
        row({ id: 'keep3', kind: 'mod' }),
        row({ id: 'gone' }),
      );
      await svc.removeDatapack(SERVER, 'a.zip');
      expect(rows.map((r) => r.id)).toEqual(['keep1', 'keep2', 'keep3']);
    });

    it('removes every copy of a pack present in both dirs', async () => {
      put('world/datapacks/a.zip', '123');
      put('world/datapacks.disabled/a.zip', '45');
      put('world/datapacks/a.zip.disabled', '6');
      rows.push(row({}));
      await expect(svc.removeDatapack(SERVER, 'a.zip')).resolves.toEqual({
        freedBytes: 6,
      });
      expect(exists('world/datapacks/a.zip')).toBe(false);
      expect(exists('world/datapacks.disabled/a.zip')).toBe(false);
      expect(exists('world/datapacks/a.zip.disabled')).toBe(false);
      expect(rows).toHaveLength(0);
    });

    it('removes a directory tree without following symlinks inside it', async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
      try {
        fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
        put('world/datapacks/d/pack.mcmeta', mcmeta('d'));
        fs.symlinkSync(
          outside,
          path.join(serverDir(), 'world/datapacks/d/link'),
        );
        await svc.removeDatapack(SERVER, 'd');
        expect(exists('world/datapacks/d')).toBe(false);
        expect(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8')).toBe(
          'keep',
        );
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('404s when neither a pack nor a row exists', async () => {
      await expect(svc.removeDatapack(SERVER, 'nope.zip')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
