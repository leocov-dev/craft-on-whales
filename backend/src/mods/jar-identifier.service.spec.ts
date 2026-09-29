import { Test } from '@nestjs/testing';
import {
  BadGatewayException,
  Logger,
  PreconditionFailedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { buildZipFixture } from '../utils/zip-fixture.test-helpers';
import { ModrinthApiService } from './modrinth-api.service';
import { CurseforgeApiService } from './curseforge-api.service';
import { curseforgeFingerprint } from './curseforge-fingerprint';
import {
  JarIdentifierService,
  splitCurseforgeGameVersions,
} from './jar-identifier.service';
import type {
  CurseforgeFile,
  CurseforgeFingerprintMatch,
  CurseforgeMod,
  JarInput,
  ModrinthProject,
  ModrinthVersionWithProject,
} from './mods.types';

const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('hex');

const fabricJar = (id: string, name: string): JarInput => ({
  filename: `${id}-1.0.0.jar`,
  data: buildZipFixture([
    {
      name: 'fabric.mod.json',
      content: JSON.stringify({ id, name, version: '1.0.0' }),
    },
  ]),
});

const mrVersion = (
  projectId: string,
  over: Partial<ModrinthVersionWithProject> = {},
): ModrinthVersionWithProject => ({
  id: `${projectId}-v`,
  project_id: projectId,
  name: 'Some release',
  version_number: '0.5.8',
  game_versions: ['1.20.1'],
  loaders: ['fabric'],
  files: [],
  ...over,
});

const mrProject = (id: string, title: string): ModrinthProject => ({
  id,
  slug: title.toLowerCase(),
  title,
  icon_url: `https://cdn.modrinth.com/${id}.png`,
  project_type: 'mod',
});

const cfFile = (over: Partial<CurseforgeFile> = {}): CurseforgeFile => ({
  fileId: 4242,
  name: 'jei-1.20.1-forge-15.2.0.27.jar',
  fileName: 'jei-1.20.1-forge-15.2.0.27.jar',
  downloadUrl: null,
  gameVersions: ['1.20.1', 'Forge', 'NeoForge', 'Server', 'Java 17'],
  releaseType: 'release',
  fileDate: '2026-01-01T00:00:00Z',
  fileLength: 1,
  hashes: [],
  serverPackFileId: null,
  dependencies: [],
  ...over,
});

const cfMod = (modId: number, name: string, classId = 6): CurseforgeMod => ({
  modId,
  slug: name.toLowerCase().replace(/ /g, '-'),
  name,
  summary: '',
  iconUrl: `https://media.forgecdn.net/${modId}.png`,
  downloads: 0,
  classId,
  latestFiles: [],
});

describe('splitCurseforgeGameVersions', () => {
  it('separates MC versions from loaders and drops other tags', () => {
    expect(
      splitCurseforgeGameVersions([
        '1.20.1',
        '1.20',
        'Forge',
        'NeoForge',
        'Server',
        'Client',
        'Java 17',
        '1.20-Snapshot',
      ]),
    ).toEqual({
      mcVersions: ['1.20.1', '1.20'],
      loaders: ['forge', 'neoforge'],
    });
  });
});

describe('JarIdentifierService', () => {
  let service: JarIdentifierService;
  const modrinth = {
    getVersionsByHashes: jest.fn<
      Promise<Map<string, ModrinthVersionWithProject>>,
      [string[]]
    >(),
    getProjects: jest.fn<Promise<Map<string, ModrinthProject>>, [string[]]>(),
  };
  const curseforge = {
    getFingerprintMatches: jest.fn<
      Promise<CurseforgeFingerprintMatch[]>,
      [number[]]
    >(),
    getMods: jest.fn<Promise<Map<number, CurseforgeMod>>, [number[]]>(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    modrinth.getVersionsByHashes.mockResolvedValue(new Map());
    modrinth.getProjects.mockResolvedValue(new Map());
    curseforge.getFingerprintMatches.mockResolvedValue([]);
    curseforge.getMods.mockResolvedValue(new Map());
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [
        JarIdentifierService,
        { provide: ModrinthApiService, useValue: modrinth },
        { provide: CurseforgeApiService, useValue: curseforge },
      ],
    }).compile();
    service = moduleRef.get(JarIdentifierService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('identifies by Modrinth sha1 first and skips the later layers', async () => {
    const jar = fabricJar('sodium', 'Sodium (from manifest)');
    modrinth.getVersionsByHashes.mockResolvedValue(
      new Map([[sha1(jar.data), mrVersion('AANobbMI')]]),
    );
    modrinth.getProjects.mockResolvedValue(
      new Map([['AANobbMI', mrProject('AANobbMI', 'Sodium')]]),
    );

    const result = await service.identify(jar);

    expect(modrinth.getVersionsByHashes).toHaveBeenCalledWith([sha1(jar.data)]);
    expect(modrinth.getProjects).toHaveBeenCalledWith(['AANobbMI']);
    expect(curseforge.getFingerprintMatches).not.toHaveBeenCalled();
    expect(result).toEqual({
      filename: 'sodium-1.0.0.jar',
      size: jar.data.length,
      sha1: sha1(jar.data),
      sha256: createHash('sha256').update(jar.data).digest('hex'),
      fingerprint: curseforgeFingerprint(jar.data),
      source: 'modrinth',
      platform: 'modrinth',
      projectId: 'AANobbMI',
      versionId: 'AANobbMI-v',
      slug: 'sodium',
      name: 'Sodium',
      version: '0.5.8',
      iconUrl: 'https://cdn.modrinth.com/AANobbMI.png',
      loaders: ['fabric'],
      mcVersions: ['1.20.1'],
      mcConstraint: null,
      kind: 'mod',
    });
  });

  it('marks a Modrinth file whose loaders are all plugin platforms as a plugin', async () => {
    const jar = fabricJar('lp', 'LuckPerms');
    modrinth.getVersionsByHashes.mockResolvedValue(
      new Map([
        [
          sha1(jar.data),
          mrVersion('Vebnzrzj', { loaders: ['bukkit', 'Paper'] }),
        ],
      ]),
    );
    const result = await service.identify(jar);
    expect(result).toMatchObject({
      source: 'modrinth',
      kind: 'plugin',
      loaders: ['bukkit', 'paper'],
    });
  });

  it('keeps a Modrinth match when the project lookup fails', async () => {
    const jar = fabricJar('sodium', 'Sodium');
    modrinth.getVersionsByHashes.mockResolvedValue(
      new Map([[sha1(jar.data), mrVersion('AANobbMI')]]),
    );
    modrinth.getProjects.mockRejectedValue(new BadGatewayException('down'));
    const result = await service.identify(jar);
    expect(result).toMatchObject({
      source: 'modrinth',
      slug: 'AANobbMI',
      name: 'Some release',
      iconUrl: null,
    });
  });

  it('falls back to the CurseForge fingerprint for jars Modrinth does not know', async () => {
    const jar = fabricJar('jei', 'JEI (from manifest)');
    curseforge.getFingerprintMatches.mockResolvedValue([
      {
        modId: 238222,
        fingerprint: curseforgeFingerprint(jar.data),
        file: cfFile(),
      },
    ]);
    curseforge.getMods.mockResolvedValue(
      new Map([[238222, cfMod(238222, 'Just Enough Items')]]),
    );

    const result = await service.identify(jar);

    expect(curseforge.getFingerprintMatches).toHaveBeenCalledWith([
      curseforgeFingerprint(jar.data),
    ]);
    expect(result).toMatchObject({
      source: 'curseforge',
      platform: 'curseforge',
      projectId: '238222',
      versionId: '4242',
      slug: 'just-enough-items',
      name: 'Just Enough Items',
      version: 'jei-1.20.1-forge-15.2.0.27.jar',
      iconUrl: 'https://media.forgecdn.net/238222.png',
      loaders: ['forge', 'neoforge'],
      mcVersions: ['1.20.1'],
      kind: 'mod',
    });
  });

  it('marks a CurseForge Bukkit-plugins project as a plugin', async () => {
    const jar = fabricJar('ess', 'Essentials');
    curseforge.getFingerprintMatches.mockResolvedValue([
      {
        modId: 93271,
        fingerprint: curseforgeFingerprint(jar.data),
        file: cfFile({ gameVersions: ['1.20.1'] }),
      },
    ]);
    curseforge.getMods.mockResolvedValue(
      new Map([[93271, cfMod(93271, 'EssentialsX', 5)]]),
    );
    expect(await service.identify(jar)).toMatchObject({
      source: 'curseforge',
      kind: 'plugin',
    });
  });

  it('falls back to jar metadata when neither registry matches', async () => {
    const result = await service.identify(fabricJar('custom', 'My Custom Mod'));
    expect(curseforge.getFingerprintMatches).toHaveBeenCalled();
    expect(result).toMatchObject({
      source: 'metadata',
      platform: null,
      projectId: null,
      name: 'My Custom Mod',
      version: '1.0.0',
      loaders: ['fabric'],
      kind: 'mod',
    });
  });

  it('returns an unknown result named after the file when nothing matches', async () => {
    const result = await service.identify({
      filename: 'Private-Build.JAR',
      data: buildZipFixture([{ name: 'a/B.class', content: 'x' }]),
    });
    expect(result).toMatchObject({
      source: 'unknown',
      platform: null,
      name: 'Private-Build',
      version: null,
      loaders: [],
      kind: null,
    });
  });

  it('carries on to the next layer when a registry errors, and skips CurseForge quietly without a key', async () => {
    modrinth.getVersionsByHashes.mockRejectedValue(
      new BadGatewayException('Modrinth answered HTTP 500'),
    );
    curseforge.getFingerprintMatches.mockRejectedValue(
      new PreconditionFailedException('CurseForge API key not set'),
    );
    const warn = jest.spyOn(Logger.prototype, 'warn');

    const result = await service.identify(fabricJar('custom', 'Custom'));

    expect(result.source).toBe('metadata');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('Modrinth hash lookup failed');
  });

  it('batches a mixed set: one request per layer, results in input order', async () => {
    const a = fabricJar('a', 'A'); // Modrinth
    const b = fabricJar('b', 'B'); // CurseForge
    const c = fabricJar('c', 'C'); // metadata only
    modrinth.getVersionsByHashes.mockResolvedValue(
      new Map([[sha1(a.data), mrVersion('projA')]]),
    );
    curseforge.getFingerprintMatches.mockResolvedValue([
      { modId: 1, fingerprint: curseforgeFingerprint(b.data), file: cfFile() },
    ]);

    const results = await service.identifyMany([a, b, c]);

    expect(results.map((r) => [r.filename, r.source])).toEqual([
      ['a-1.0.0.jar', 'modrinth'],
      ['b-1.0.0.jar', 'curseforge'],
      ['c-1.0.0.jar', 'metadata'],
    ]);
    expect(modrinth.getVersionsByHashes).toHaveBeenCalledTimes(1);
    expect(modrinth.getVersionsByHashes.mock.calls[0]![0]).toHaveLength(3);
    // Only the jars Modrinth missed go to CurseForge.
    expect(curseforge.getFingerprintMatches).toHaveBeenCalledWith([
      curseforgeFingerprint(b.data),
      curseforgeFingerprint(c.data),
    ]);
  });

  it('makes no registry calls for an empty batch', async () => {
    expect(await service.identifyMany([])).toEqual([]);
    expect(modrinth.getVersionsByHashes).not.toHaveBeenCalled();
    expect(curseforge.getFingerprintMatches).not.toHaveBeenCalled();
  });
});
