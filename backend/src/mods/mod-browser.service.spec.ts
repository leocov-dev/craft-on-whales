import { ModBrowserService, platformServesLoader } from './mod-browser.service';
import { fromModsSchema } from './mod-browser-orchestrator.service';
import { ModsService } from './mods.service';
import { HangarApiService, parseHangarRef } from './hangar-api.service';
import { SpigetApiService, parseSpigetRef } from './spiget-api.service';
import type { ApiCacheService } from './api-cache.service';
import type { ModrinthApiService } from './modrinth-api.service';
import type { CurseforgeApiService } from './curseforge-api.service';

// The mod browser's Hangar / Spiget branches run through the real API
// clients with `fetch` stubbed per URL, so the query parameters the registries
// actually receive (platform, MC version) are asserted too. Modrinth and
// CurseForge are recording fakes: only what ModBrowserService asks of them
// matters here.

class FakeApiCache {
  rows = new Map<string, { value: unknown; ageMs: number }>();
  get(key: string) {
    return Promise.resolve(this.rows.get(key) ?? null);
  }
  set(key: string, value: unknown) {
    this.rows.set(key, { value: structuredClone(value), ageMs: 0 });
    return Promise.resolve();
  }
}

type Route = (url: URL) => Response | null;

const toUrl = (input: string | URL | Request): URL =>
  new URL(input instanceof Request ? input.url : input);

const json = (body: unknown) => Response.json(body);

// --- Hangar fixtures --------------------------------------------------------

const hangarProject = {
  name: 'ViaVersion',
  namespace: { owner: 'ViaVersion', slug: 'ViaVersion' },
  description: 'Allow newer clients to connect',
  avatarUrl: 'https://hangarcdn.papermc.io/avatars/project/31.webp',
  stats: { downloads: 499736 },
};

const hangarVersion = (
  name: string,
  mc: string[],
  {
    channel = 'Release',
    hosted = true,
  }: { channel?: string; hosted?: boolean } = {},
) => ({
  name,
  createdAt: '2026-08-01T00:00:00Z',
  channel: { name: channel },
  platformDependencies: { PAPER: mc },
  downloads: {
    PAPER: hosted
      ? {
          fileInfo: {
            name: `ViaVersion-${name}.jar`,
            sizeBytes: 5,
            sha256Hash: 'e'.repeat(64),
          },
          downloadUrl: `https://hangarcdn.papermc.io/ViaVersion-${name}.jar`,
          externalUrl: null,
        }
      : {
          fileInfo: null,
          downloadUrl: null,
          externalUrl: 'https://github.com/ViaVersion/ViaVersion/releases',
        },
  },
});

// --- Spiget fixtures --------------------------------------------------------

const spigetResource = ({
  id = 28140,
  premium = false,
  external = false,
}: { id?: number; premium?: boolean; external?: boolean } = {}) => ({
  id,
  name: 'LuckPerms',
  tag: 'A permissions plugin',
  downloads: 12,
  icon: { url: 'data/resource_icons/28/28140.jpg' },
  testedVersions: ['1.20', '1.21'],
  premium,
  external,
  file: external
    ? { type: 'external', externalUrl: 'https://example.org/lp' }
    : { type: '.jar' },
});

describe('ModBrowserService — Hangar / Spiget', () => {
  let browser: ModBrowserService;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let routes: Route[];
  let modrinthCalls: { method: string; args: unknown }[];
  let curseforgeCalls: { method: string; args: unknown }[];

  const fetched = () => fetchMock.mock.calls.map(([u]) => toUrl(u));

  beforeEach(() => {
    routes = [];
    modrinthCalls = [];
    curseforgeCalls = [];
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation((input) => {
      const url = toUrl(input);
      for (const route of routes) {
        const res = route(url);
        if (res) return Promise.resolve(res);
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    const cache = new FakeApiCache() as unknown as ApiCacheService;
    const modrinth = {
      search: (args: unknown) => {
        modrinthCalls.push({ method: 'search', args });
        return Promise.resolve([]);
      },
    } as unknown as ModrinthApiService;
    const curseforge = {
      search: (args: unknown) => {
        curseforgeCalls.push({ method: 'search', args });
        return Promise.resolve([]);
      },
    } as unknown as CurseforgeApiService;
    browser = new ModBrowserService(
      modrinth,
      curseforge,
      new HangarApiService(cache),
      new SpigetApiService(cache),
    );
  });

  afterEach(() => fetchMock.mockRestore());

  describe('platformServesLoader', () => {
    it('limits the plugin registries to Paper, and leaves the rest alone', () => {
      for (const p of ['hangar', 'spiget'] as const) {
        expect(platformServesLoader(p, 'paper')).toBe(true);
        expect(platformServesLoader(p, undefined)).toBe(true);
        for (const l of ['fabric', 'forge', 'neoforge', 'quilt'])
          expect(platformServesLoader(p, l)).toBe(false);
      }
      for (const p of ['modrinth', 'curseforge'] as const) {
        expect(platformServesLoader(p, 'fabric')).toBe(true);
        expect(platformServesLoader(p, 'paper')).toBe(true);
      }
    });
  });

  describe('search', () => {
    it('searches Hangar for PAPER builds on the server MC version', async () => {
      routes.push((u) =>
        u.pathname === '/api/v1/projects'
          ? json({ result: [hangarProject] })
          : null,
      );
      const hits = await browser.search({
        query: 'via',
        platform: 'hangar',
        loader: 'paper',
        mc: '1.21.4',
      });
      expect(hits).toEqual([
        {
          platform: 'hangar',
          ref: 'ViaVersion/ViaVersion',
          projectId: 'ViaVersion',
          name: 'ViaVersion',
          description: 'Allow newer clients to connect',
          iconUrl: 'https://hangarcdn.papermc.io/avatars/project/31.webp',
          downloads: 499736,
        },
      ]);
      const q = fetched()[0]!.searchParams;
      expect(q.get('q')).toBe('via');
      expect(q.get('platform')).toBe('PAPER');
      expect(q.get('version')).toBe('1.21.4');
    });

    it("doesn't send LATEST/SNAPSHOT to Hangar as an MC version", async () => {
      routes.push((u) =>
        u.pathname === '/api/v1/projects' ? json({ result: [] }) : null,
      );
      await browser.search({ query: 'via', platform: 'hangar', mc: 'LATEST' });
      expect(fetched()[0]!.searchParams.has('version')).toBe(false);
    });

    it('searches Spiget by name, keyed by resource id', async () => {
      routes.push((u) =>
        u.pathname === '/v2/search/resources/luck'
          ? json([spigetResource()])
          : null,
      );
      const hits = await browser.search({
        query: 'luck',
        platform: 'spiget',
        loader: 'paper',
        mc: '1.21.4',
      });
      expect(hits).toEqual([
        {
          platform: 'spiget',
          ref: '28140',
          projectId: '28140',
          name: 'LuckPerms',
          description: 'A permissions plugin',
          iconUrl: 'https://www.spigotmc.org/data/resource_icons/28/28140.jpg',
          downloads: 12,
        },
      ]);
    });

    it('answers a mod-loader search on Hangar/Spiget with nothing, offline', async () => {
      for (const platform of ['hangar', 'spiget'] as const)
        for (const loader of ['fabric', 'forge', 'neoforge', 'quilt'])
          expect(
            await browser.search({ query: 'via', platform, loader }),
          ).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('searches plugins, not mods, on Modrinth/CurseForge for Paper', async () => {
      await browser.search({
        query: 'lp',
        platform: 'modrinth',
        loader: 'paper',
      });
      await browser.search({
        query: 'lp',
        platform: 'curseforge',
        loader: 'paper',
      });
      await browser.search({
        query: 'jei',
        platform: 'modrinth',
        loader: 'fabric',
      });
      await browser.search({
        query: 'jei',
        platform: 'curseforge',
        loader: 'fabric',
      });
      expect(modrinthCalls.map((c) => c.args)).toEqual([
        expect.objectContaining({ kind: 'plugin', loader: 'paper' }),
        expect.objectContaining({ kind: 'mod', loader: 'fabric' }),
      ]);
      expect(curseforgeCalls.map((c) => c.args)).toEqual([
        expect.objectContaining({ kind: 'plugin', loader: undefined }),
        expect.objectContaining({ kind: 'mod', loader: 'fabric' }),
      ]);
    });

    it('still defaults to Modrinth', async () => {
      await browser.search({ query: 'sodium', loader: 'fabric' });
      expect(modrinthCalls).toHaveLength(1);
    });
  });

  describe('versions', () => {
    beforeEach(() => {
      routes.push((u) => {
        if (u.pathname === '/api/v1/projects/ViaVersion')
          return json(hangarProject);
        if (u.pathname === '/api/v1/projects/ViaVersion/versions')
          return json({
            result: [
              hangarVersion('5.3.0-SNAPSHOT', ['1.21.4'], {
                channel: 'Snapshot',
              }),
              hangarVersion('5.2.1', ['1.21']),
              hangarVersion('5.1.0', ['1.20.6']),
              hangarVersion('5.0.9', ['1.21.4'], { hosted: false }),
            ],
          });
        return null;
      });
    });

    it('lists Hangar PAPER builds compatible with the MC version', async () => {
      const vers = await browser.versions({
        platform: 'hangar',
        ref: 'ViaVersion/ViaVersion',
        loader: 'paper',
        mc: '1.21.4',
      });
      expect(vers.map((v) => v.versionId)).toEqual([
        '5.3.0-SNAPSHOT',
        '5.2.1', // a bare "1.21" tag fits a 1.21.4 server
        '5.0.9',
      ]);
      expect(vers[0]).toEqual({
        versionId: '5.3.0-SNAPSHOT',
        name: '5.3.0-SNAPSHOT',
        versionNumber: '5.3.0-SNAPSHOT',
        datePublished: '2026-08-01T00:00:00Z',
        versionType: 'alpha',
        gameVersions: ['1.21.4'],
        requiredDeps: [],
        downloadable: true,
      });
      // Externally hosted: install would be a 409, so it's flagged.
      expect(vers[2]!.downloadable).toBe(false);
      const list = fetched().find((u) => u.pathname.endsWith('/versions'))!;
      expect(list.searchParams.get('platform')).toBe('PAPER');
    });

    it('takes a bare Hangar slug too', async () => {
      const vers = await browser.versions({
        platform: 'hangar',
        ref: 'ViaVersion',
      });
      expect(vers).toHaveLength(4);
    });

    it('lists Spiget versions newest first with the tested MC versions', async () => {
      routes.push((u) => {
        if (u.pathname === '/v2/resources/28140') return json(spigetResource());
        if (u.pathname === '/v2/resources/28140/versions')
          return json([
            { id: 600, name: '5.5.71', releaseDate: 1780000000 },
            { id: 500, name: '5.5.0', releaseDate: null },
          ]);
        return null;
      });
      const vers = await browser.versions({
        platform: 'spiget',
        ref: '28140',
        loader: 'paper',
        mc: '1.21.4',
      });
      expect(vers).toEqual([
        {
          versionId: '600',
          name: '5.5.71',
          versionNumber: '5.5.71',
          datePublished: new Date(1780000000 * 1000).toISOString(),
          versionType: 'release',
          gameVersions: ['1.20', '1.21'],
          requiredDeps: [],
          downloadable: true,
        },
        expect.objectContaining({ versionId: '500', datePublished: null }),
      ]);
      const list = fetched().find((u) => u.pathname.endsWith('/versions'))!;
      expect(list.searchParams.get('sort')).toBe('-id');
    });

    it.each([[{ premium: true }], [{ external: true }]])(
      'flags every version of a %o Spiget resource undownloadable',
      async (flags) => {
        routes.push((u) => {
          if (u.pathname === '/v2/resources/28140')
            return json(spigetResource(flags));
          if (u.pathname === '/v2/resources/28140/versions')
            return json([{ id: 600, name: '5.5.71' }]);
          return null;
        });
        const vers = await browser.versions({
          platform: 'spiget',
          ref: '28140',
        });
        expect(vers.map((v) => v.downloadable)).toEqual([false]);
      },
    );

    it('answers a mod-loader version list on Hangar/Spiget with nothing, offline', async () => {
      expect(
        await browser.versions({
          platform: 'hangar',
          ref: 'ViaVersion/ViaVersion',
          loader: 'fabric',
        }),
      ).toEqual([]);
      expect(
        await browser.versions({
          platform: 'spiget',
          ref: '28140',
          loader: 'forge',
        }),
      ).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('resolveDependencies', () => {
    it('has nothing to resolve for Hangar/Spiget picks', async () => {
      routes.push((u) => {
        if (u.pathname === '/api/v1/projects/ViaVersion')
          return json(hangarProject);
        if (u.pathname === '/v2/resources/28140') return json(spigetResource());
        return null;
      });
      const out = await browser.resolveDependencies({
        loader: 'paper',
        mc: '1.21.4',
        selection: [
          {
            platform: 'hangar',
            ref: 'ViaVersion/ViaVersion',
            versionId: '5.2.1',
          },
          { platform: 'spiget', ref: '28140', versionId: '600' },
        ],
      });
      expect(out).toEqual({ deps: [], warnings: [] });
      // Only the project lookups; no per-version dependency fetches.
      expect(
        fetched()
          .map((u) => u.pathname)
          .sort(),
      ).toEqual(['/api/v1/projects/ViaVersion', '/v2/resources/28140']);
    });
  });
});

describe('refToUrl for the plugin registries', () => {
  // refToUrl doesn't touch instance state.
  const refToUrl = ModsService.prototype.refToUrl.bind({} as ModsService);

  it('builds Hangar page URLs installFromUrl reads back', () => {
    expect(refToUrl('hangar', 'ViaVersion/ViaVersion')).toBe(
      'https://hangar.papermc.io/ViaVersion/ViaVersion',
    );
    const pinned = refToUrl('hangar', 'ViaVersion/ViaVersion', '5.3.0+1074');
    expect(pinned).toBe(
      'https://hangar.papermc.io/ViaVersion/ViaVersion/versions/5.3.0%2B1074',
    );
    expect(parseHangarRef(pinned)).toEqual({
      slug: 'ViaVersion',
      versionName: '5.3.0+1074',
    });
  });

  it('builds SpigotMC resource URLs installFromUrl reads back', () => {
    expect(refToUrl('spiget', '28140')).toBe(
      'https://www.spigotmc.org/resources/28140/',
    );
    expect(parseSpigetRef(refToUrl('spiget', '28140', '600'))).toEqual({
      resourceId: 28140,
      versionId: '600',
    });
  });

  it('leaves Modrinth and CurseForge URLs as they were', () => {
    expect(refToUrl('modrinth', 'sodium', 'abc')).toBe(
      'https://modrinth.com/mod/sodium/version/abc',
    );
    expect(refToUrl('curseforge', 'jei', '123')).toBe(
      'https://www.curseforge.com/minecraft/mc-mods/jei/files/123',
    );
  });
});

describe('fromModsSchema with Hangar/Spiget picks', () => {
  const base = { name: 'Plugins', mcVersion: '1.21.4' };

  it('accepts plugin-registry picks on a Paper server', () => {
    const parsed = fromModsSchema.parse({
      ...base,
      loader: 'paper',
      mods: [
        {
          platform: 'hangar',
          ref: 'ViaVersion/ViaVersion',
          versionId: '5.3.0+1074',
        },
        { platform: 'spiget', ref: '28140' },
        { platform: 'modrinth', ref: 'luckperms' },
      ],
    });
    expect(parsed.mods).toHaveLength(3);
  });

  it('refuses them on a mod-loader server', () => {
    const res = fromModsSchema.safeParse({
      ...base,
      loader: 'fabric',
      mods: [{ platform: 'hangar', ref: 'ViaVersion/ViaVersion' }],
    });
    expect(res.success).toBe(false);
    expect(res.error?.issues[0]?.message).toMatch(/only host Paper\/Spigot/);
  });

  it('refuses refs refToUrl could not turn into a page URL', () => {
    for (const mod of [
      { platform: 'hangar', ref: 'ViaVersion' }, // no owner
      { platform: 'hangar', ref: 'a/b/c' },
      { platform: 'spiget', ref: 'luckperms.28140' },
    ])
      expect(
        fromModsSchema.safeParse({ ...base, loader: 'paper', mods: [mod] })
          .success,
      ).toBe(false);
  });

  it('keeps accepting mod-loader picks as before', () => {
    expect(
      fromModsSchema.safeParse({
        ...base,
        loader: 'fabric',
        mods: [{ platform: 'modrinth', ref: 'sodium', versionId: 'abc' }],
      }).success,
    ).toBe(true);
  });
});
