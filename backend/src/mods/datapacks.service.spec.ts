import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '../config/config.service';
import { PathGuardService } from '../storage/path-guard.service';
import { buildZipFixture } from '../utils/zip-fixture.test-helpers';
import { DatapacksService, parsePackMeta } from './datapacks.service';

const SERVER = 'srv1';

interface Row {
  id: string;
  filename: string;
  kind: string;
  managedBy: string;
  name: string;
  version: string | null;
  iconUrl: string | null;
  libraryId: string | null;
  enabled: boolean;
}

describe('DatapacksService', () => {
  let root: string;
  let props: Map<string, string>;
  let env: Record<string, string>;
  let rows: Row[];
  let updates: unknown[];
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
    updates = [];
    const pathGuard = new PathGuardService({ dataDir: root } as ConfigService);
    const db = {
      select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
      update: () => ({
        set: (v: unknown) => ({
          where: () => {
            updates.push(v);
            return Promise.resolve();
          },
        }),
      }),
      delete: () => ({
        where: () => ({
          returning: () => {
            const gone = rows.splice(0, rows.length);
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
      rows.push({
        id: 'sc_1',
        filename: 'gone.zip',
        kind: 'datapack',
        managedBy: 'overlay',
        name: 'Gone',
        version: null,
        iconUrl: null,
        libraryId: null,
        enabled: true,
      });
      const [item] = await svc.listDatapacks(SERVER);
      expect(item).toMatchObject({ file: 'gone.zip', missing: true });
    });
  });

  describe('setEnabled', () => {
    it('moves a pack out to datapacks.disabled and back, creating the dir', async () => {
      put('world/datapacks/a.zip');
      await expect(svc.setEnabled(SERVER, 'a.zip', false)).resolves.toEqual({
        applied: 'on-restart',
      });
      expect(exists('world/datapacks/a.zip')).toBe(false);
      expect(exists('world/datapacks.disabled/a.zip')).toBe(true);
      expect(updates).toEqual([{ enabled: false }]);
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

  describe('removeDatapack', () => {
    it('removes a file from either dir and drops its row', async () => {
      put('world/datapacks.disabled/a.zip', '12345');
      rows.push({
        id: 'sc_1',
        filename: 'a.zip',
        kind: 'datapack',
        managedBy: 'overlay',
        name: 'A',
        version: null,
        iconUrl: null,
        libraryId: null,
        enabled: false,
      });
      await expect(svc.removeDatapack(SERVER, 'a.zip')).resolves.toEqual({
        freedBytes: 5,
      });
      expect(exists('world/datapacks.disabled/a.zip')).toBe(false);
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
