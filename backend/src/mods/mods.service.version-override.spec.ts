import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BlockedDownloadException } from './blocked-download.exception';
import { ModsService } from './mods.service';
import { ModrinthApiService } from './modrinth-api.service';
import type { ApiCacheService } from './api-cache.service';
import type { DownloadMeta } from '../library/library.service';

// The MC-version override on add-by-link, end to end through the real
// Modrinth client with `fetch` stubbed. A Quilt server on 1.21.2.

const file = (id: string) => ({
  url: `https://cdn.modrinth.com/${id}.jar`,
  filename: `${id}.jar`,
  primary: true,
  hashes: { sha1: 'a', sha512: 'b' },
  size: 1,
});
const version = (id: string, loaders: string[], mc: string[]) => ({
  id,
  version_number: id,
  game_versions: mc,
  loaders,
  files: [file(id)],
});

// What the project has built, newest first.
const BUILDS = [
  version('fabric-1.21.3', ['fabric'], ['1.21.3']),
  version('quilt-1.21.1', ['quilt'], ['1.21.1']),
  version('fabric-1.21.1', ['fabric'], ['1.21.1']),
];

describe('ModsService MC-version override', () => {
  let mods: ModsService;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let downloads: DownloadMeta[];
  let events: { summary: string; details: Record<string, unknown> }[];
  let builds: typeof BUILDS;
  const server = {
    id: 'srv1',
    type: 'QUILT',
    mc_version: '1.21.2',
    env: {},
  };

  beforeEach(() => {
    downloads = [];
    events = [];
    builds = BUILDS;
    server.env = {};
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation((input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === '/v2/project/sodium')
        return Promise.resolve(
          Response.json({
            id: 'P1',
            slug: 'sodium',
            title: 'Sodium',
            project_type: 'mod',
          }),
        );
      if (url.pathname === '/v2/project/P1/version') {
        const loaders = JSON.parse(
          url.searchParams.get('loaders') ?? '[]',
        ) as string[];
        const mc = url.searchParams.get('game_versions');
        const wanted = mc ? (JSON.parse(mc) as string[]) : null;
        return Promise.resolve(
          Response.json(
            builds.filter(
              (b) =>
                b.loaders.some((l) => loaders.includes(l)) &&
                (!wanted || b.game_versions.some((g) => wanted.includes(g))),
            ),
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    const cache = {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
    } as unknown as ApiCacheService;
    const library = {
      downloadToLibrary: (_url: string, meta: DownloadMeta) => {
        downloads.push(meta);
        return Promise.resolve({
          id: 'lib1',
          name: meta.name,
          version: meta.version ?? null,
          iconUrl: null,
          sizeBytes: 1,
        });
      },
      installToServer: () =>
        Promise.resolve({ installedPath: '/x', filename: 'x.jar' }),
    };
    const dbService = {
      db: {
        insert: () => ({
          values: () => ({ onConflictDoUpdate: () => Promise.resolve() }),
        }),
      },
    };
    mods = new ModsService(
      dbService as never,
      {} as never,
      {
        assertUnderQuota: () => Promise.resolve(),
        scan: () => Promise.resolve(),
      } as never,
      {
        recordEvent: (e: (typeof events)[number]) => events.push(e),
      } as never,
      library as never,
      new ModrinthApiService(cache),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { getServer: () => Promise.resolve(server) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never, // datapacks
    );
  });
  afterEach(() => fetchMock.mockRestore());

  const install = (ignoreVersion?: boolean) =>
    mods.installFromUrl('srv1', 'https://modrinth.com/mod/sodium', {
      ignoreVersion,
    });

  it('refuses a project with no build for the exact MC version by default', async () => {
    await expect(install()).rejects.toBeInstanceOf(NotFoundException);
    expect(downloads).toHaveLength(0);
  });

  it('refuses the override on a packwiz server, whose pack pins the version', async () => {
    server.env = { PACKWIZ_URL: 'https://example.com/pack.toml' };
    await expect(install(true)).rejects.toBeInstanceOf(BadRequestException);
    expect(downloads).toHaveLength(0);
  });

  it('treats a PACKWIZ_URL server as pack-managed even though its type is a loader', () => {
    const packwiz = {
      type: 'FABRIC',
      env: { PACKWIZ_URL: 'https://example.com/pack.toml' },
    };
    expect(mods.isPackServer(packwiz)).toBe(true);
    expect(() => mods.assertAcceptsManualContent(packwiz)).toThrow(
      BadRequestException,
    );
    expect(mods.isPackServer({ type: 'FABRIC', env: {} })).toBe(false);
  });

  it('with the override, installs the own-loader build over a newer fabric one', async () => {
    const result = await install(true);
    expect(downloads[0]!.fileId).toBe('quilt-1.21.1');
    expect(result.versionOverridden).toBe(true);
    expect(events[0]!.summary).toContain('version check overridden');
    expect(events[0]!.details.versionOverridden).toBe(true);
  });

  it('with the override, takes a fabric build when no quilt build exists', async () => {
    builds = BUILDS.filter((b) => !b.loaders.includes('quilt'));
    await install(true);
    expect(downloads[0]!.fileId).toBe('fabric-1.21.3');
  });

  it('prefers an exact-version build over the override, and does not flag it', async () => {
    builds = [...BUILDS, version('fabric-1.21.2', ['fabric'], ['1.21.2'])];
    const result = await install(true);
    expect(downloads[0]!.fileId).toBe('fabric-1.21.2');
    expect(result.versionOverridden).toBeFalsy();
  });

  it('never relaxes the loader: no matching-loader build still fails', async () => {
    builds = [version('forge-1.21.1', ['forge'], ['1.21.1'])];
    await expect(install(true)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('without the override, a quilt server still prefers quilt at its exact version', async () => {
    builds = [
      version('fabric-1.21.2', ['fabric'], ['1.21.2']),
      version('quilt-1.21.2', ['quilt'], ['1.21.2']),
    ];
    const result = await install();
    expect(downloads[0]!.fileId).toBe('quilt-1.21.2');
    expect(result.versionOverridden).toBeFalsy();
  });

  type Resolver = {
    resolveSource: (source: unknown, target: unknown) => Promise<unknown>;
    resolveForServer: (...args: unknown[]) => Promise<unknown>;
  };

  it('with the override, a blocked no-MC-filter build surfaces as blocked, not as "no build"', async () => {
    const blocked = new BlockedDownloadException(
      {
        source: 'curseforge',
        reason: 'distribution-disabled',
        name: 'Sodium',
        version: 'x',
        filename: 'x.jar',
        pageUrl: 'https://example.com',
        externalUrl: null,
        verifiable: false,
      },
      {},
    );
    jest
      .spyOn(mods as unknown as Resolver, 'resolveSource')
      .mockRejectedValueOnce(new NotFoundException('no exact build'))
      .mockRejectedValueOnce(blocked);
    await expect(install(true)).rejects.toBe(blocked);
  });

  it('a manual upload re-resolves with the override', async () => {
    const sentinel = new Error('stop after resolve');
    const spy = jest
      .spyOn(mods as unknown as Resolver, 'resolveForServer')
      .mockRejectedValue(sentinel);
    await expect(
      mods.installManualUpload('srv1', '/x', 'a.jar', 'sodium', {
        ignoreVersion: true,
      }),
    ).rejects.toBe(sentinel);
    expect(spy).toHaveBeenCalledWith(server, 'sodium', {
      ignoreVersion: true,
    });
  });
});
