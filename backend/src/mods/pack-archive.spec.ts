import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BadRequestException } from '@nestjs/common';
import {
  MAX_INDEX_FILES,
  contentJarName,
  describeStagedPack,
  overrideJarName,
  parseMrpackIndex,
} from './pack-archive';

const SHA1 = 'a'.repeat(40);
const SHA512 = 'b'.repeat(128);

const indexJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    formatVersion: 1,
    game: 'minecraft',
    versionId: '1.2.0',
    name: 'Test Pack',
    files: [
      {
        path: 'mods/sodium.jar',
        hashes: { sha1: SHA1, sha512: SHA512 },
        downloads: ['https://cdn.modrinth.com/data/x/sodium.jar'],
        env: { client: 'required', server: 'optional' },
        fileSize: 10,
      },
    ],
    dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.5' },
    ...over,
  });

describe('parseMrpackIndex', () => {
  it('reads the pack, its loader and its files', () => {
    const index = parseMrpackIndex(indexJson());
    expect(index).toMatchObject({
      name: 'Test Pack',
      version: '1.2.0',
      mcVersion: '1.21.1',
      loader: 'fabric',
      loaderVersion: '0.16.5',
      invalidFiles: 0,
    });
    expect(index.files).toEqual([
      {
        path: 'mods/sodium.jar',
        downloads: ['https://cdn.modrinth.com/data/x/sodium.jar'],
        expectedHash: { algorithm: 'sha512', hex: SHA512 },
        sha1: SHA1,
        serverEnv: 'optional',
      },
    ]);
  });

  it('maps every loader key and falls back to sha1 when there is no sha512', () => {
    for (const [key, loader] of [
      ['quilt-loader', 'quilt'],
      ['forge', 'forge'],
      ['neoforge', 'neoforge'],
    ] as const) {
      expect(
        parseMrpackIndex(
          indexJson({ dependencies: { minecraft: '1.20.1', [key]: '1' } }),
        ).loader,
      ).toBe(loader);
    }
    const index = parseMrpackIndex(
      indexJson({
        files: [
          { path: 'mods/a.jar', hashes: { sha1: SHA1 }, downloads: ['u'] },
        ],
      }),
    );
    expect(index.files[0]!.expectedHash).toEqual({
      algorithm: 'sha1',
      hex: SHA1,
    });
    expect(index.files[0]!.serverEnv).toBe('required'); // no env = required
  });

  it('drops unusable entries and counts them', () => {
    const index = parseMrpackIndex(
      indexJson({
        files: [
          { path: 'mods/nohash.jar', hashes: {}, downloads: ['u'] },
          { path: 'mods/nodl.jar', hashes: { sha1: SHA1 }, downloads: [] },
          { hashes: { sha1: SHA1 }, downloads: ['u'] },
          {
            path: 'mods/badhash.jar',
            hashes: { sha1: 'xyz' },
            downloads: ['u'],
          },
          'junk',
          { path: 'mods/ok.jar', hashes: { sha1: SHA1 }, downloads: ['u'] },
        ],
      }),
    );
    expect(index.invalidFiles).toBe(5);
    expect(index.files.map((f) => f.path)).toEqual(['mods/ok.jar']);
  });

  it.each([
    ['not JSON', '{nope', /not valid JSON/],
    ['another game', indexJson({ game: 'terraria' }), /not a Minecraft/],
    ['no files array', indexJson({ files: 'x' }), /not a Minecraft/],
    ['a JSON array', '[]', /not a Minecraft/],
  ])('rejects %s', (_label, text, message) => {
    expect(() => parseMrpackIndex(text)).toThrow(BadRequestException);
    expect(() => parseMrpackIndex(text)).toThrow(message);
  });

  it('rejects an index listing more files than the limit', () => {
    const files = Array.from({ length: MAX_INDEX_FILES + 1 }, (_, i) => ({
      path: `mods/${i}.jar`,
      hashes: { sha1: SHA1 },
      downloads: ['u'],
    }));
    expect(() => parseMrpackIndex(indexJson({ files }))).toThrow(/limit/);
  });
});

describe('contentJarName / overrideJarName', () => {
  it('accepts only a jar directly in mods/ or plugins/', () => {
    expect(contentJarName('mods/sodium.jar')).toBe('sodium.jar');
    expect(contentJarName('plugins/LuckPerms.JAR')).toBe('LuckPerms.JAR');
    expect(contentJarName('mods/sub/x.jar')).toBeNull();
    expect(contentJarName('resourcepacks/x.zip')).toBeNull();
    expect(contentJarName('config/x.jar')).toBeNull();
    expect(contentJarName('mods/../../evil.jar')).toBeNull();
    expect(contentJarName('mods/..\\evil.jar')).toBeNull();
    expect(contentJarName('mods/.hidden.jar')).toBeNull();
  });

  it('finds content jars inside override roots only', () => {
    const roots = ['overrides', 'server-overrides'];
    expect(overrideJarName('overrides/mods/a.jar', roots)).toBe('a.jar');
    expect(overrideJarName('server-overrides/plugins/b.jar', roots)).toBe(
      'b.jar',
    );
    expect(overrideJarName('overrides/config/a.jar', roots)).toBeNull();
    expect(overrideJarName('client-overrides/mods/a.jar', roots)).toBeNull();
  });
});

describe('describeStagedPack', () => {
  let dir: string;
  const put = (rel: string, content = 'x') => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cow-pack-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('detects a .mrpack by its index and lists override roots in apply order', async () => {
    put('modrinth.index.json', indexJson());
    put('server-overrides/config/a.toml');
    put('overrides/config/a.toml');
    put('client-overrides/options.txt');
    put('overrides/mods/custom.jar');
    const pack = await describeStagedPack(dir);
    expect(pack.format).toBe('mrpack');
    expect(pack.index?.name).toBe('Test Pack');
    expect(pack.overrideRoots).toEqual(['overrides', 'server-overrides']);
    expect(pack.jars.map((j) => [j.path, j.filename])).toEqual([
      ['overrides/mods/custom.jar', 'custom.jar'],
    ]);
  });

  it('refuses a .mrpack whose index is broken instead of treating it as a jar zip', async () => {
    put('modrinth.index.json', '{broken');
    put('mods/a.jar');
    await expect(describeStagedPack(dir)).rejects.toThrow(/not valid JSON/);
  });

  it('collects jars at any depth from a plain zip, ignoring junk', async () => {
    put('mods/a.jar');
    put('deep/er/b.jar');
    put('__MACOSX/mods/._a.jar');
    put('.git/x.jar');
    put('readme.txt');
    put('overrides/config/c.toml');
    put('overrides/mods/d.jar');
    put('overrides/config/not-content.jar');
    const pack = await describeStagedPack(dir);
    expect(pack.format).toBe('jars');
    expect(pack.index).toBeNull();
    expect(pack.overrideRoots).toEqual(['overrides']);
    expect(pack.jars.map((j) => j.path).sort()).toEqual([
      'deep/er/b.jar',
      'mods/a.jar',
      'overrides/mods/d.jar',
    ]);
  });

  it('accepts an overrides-only zip', async () => {
    put('overrides/config/c.toml');
    const pack = await describeStagedPack(dir);
    expect(pack.jars).toEqual([]);
    expect(pack.overrideRoots).toEqual(['overrides']);
  });

  it('rejects a zip with neither jars, an index nor overrides', async () => {
    put('readme.txt');
    put('config/x.toml');
    await expect(describeStagedPack(dir)).rejects.toThrow(
      /Unrecognized archive/,
    );
  });
});
