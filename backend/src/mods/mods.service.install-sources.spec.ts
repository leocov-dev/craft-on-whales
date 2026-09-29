import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ModsService } from './mods.service';
import { HangarApiService } from './hangar-api.service';
import { SpigetApiService } from './spiget-api.service';
import { GithubReleasesApiService } from './github-releases-api.service';
import type { ApiCacheService } from './api-cache.service';
import type { ConfigService } from '../config/config.service';
import type { DownloadMeta } from '../library/library.service';

// installFromUrl's Hangar / Spiget / GitHub branches, end to end through the
// real API clients with `fetch` stubbed per URL. Everything downstream of the
// resolve step (library, DB, events, indexer) is a recording fake — what
// matters here is which file gets downloaded, with what metadata and hash,
// and which inputs are refused before any download starts.

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

const SHA = 'e'.repeat(64);

// --- Hangar fixtures ------------------------------------------------------

const hangarProject = {
  name: 'ViaVersion',
  namespace: { owner: 'ViaVersion', slug: 'ViaVersion' },
  description: 'x',
  avatarUrl: 'https://hangarcdn.papermc.io/avatars/project/31.webp',
  stats: { downloads: 1 },
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
            sha256Hash: SHA,
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

// --- Spiget fixtures ------------------------------------------------------

const spigetResource = ({
  external = false,
  premium = false,
}: { external?: boolean; premium?: boolean } = {}) => ({
  id: 28140,
  name: 'LuckPerms',
  tag: 'perms',
  downloads: 1,
  icon: { url: 'data/resource_icons/28/28140.jpg' },
  testedVersions: ['1.20', '1.21'],
  external,
  premium,
  file: external
    ? {
        type: 'external',
        externalUrl: 'https://github.com/LuckPerms/LuckPerms/releases',
      }
    : { type: '.jar' },
});

// --- GitHub fixtures ------------------------------------------------------

const ghRepo = {
  full_name: 'EssentialsX/Essentials',
  name: 'Essentials',
  description: 'x',
  owner: { avatar_url: 'https://avatars.githubusercontent.com/u/1' },
};

const ghRelease = (
  tag: string,
  assets: string[],
  { prerelease = false, digest = true } = {},
) => ({
  tag_name: tag,
  name: null,
  draft: false,
  prerelease,
  published_at: '2026-05-31T15:00:46Z',
  html_url: `https://github.com/EssentialsX/Essentials/releases/tag/${tag}`,
  assets: assets.map((name) => ({
    name,
    size: 1,
    browser_download_url: `https://github.com/EssentialsX/Essentials/releases/download/${tag}/${name}`,
    digest: digest ? `sha256:${SHA.toUpperCase()}` : null,
  })),
});

describe('ModsService — Hangar / Spiget / GitHub sources', () => {
  let mods: ModsService;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let routes: Route[];
  let server: { id: string; type: string; mc_version: string; env: object };
  let downloads: { url: string; meta: DownloadMeta }[];
  let inserted: Record<string, unknown>[];

  const install = (input: string) =>
    mods.installFromUrl('srv1', input, { actor: 'test' });
  const fetchedPaths = () =>
    fetchMock.mock.calls.map(([u]) => toUrl(u).pathname);

  beforeEach(() => {
    routes = [];
    downloads = [];
    inserted = [];
    server = { id: 'srv1', type: 'PAPER', mc_version: '1.21.4', env: {} };

    fetchMock = jest.spyOn(global, 'fetch').mockImplementation((input) => {
      const url = toUrl(input);
      for (const route of routes) {
        const res = route(url);
        if (res) return Promise.resolve(res);
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });

    const cache = new FakeApiCache() as unknown as ApiCacheService;
    const config = { githubToken: null } as unknown as ConfigService;
    const library = {
      downloadToLibrary: (url: string, meta: DownloadMeta) => {
        downloads.push({ url, meta });
        return Promise.resolve({
          id: 'lib1',
          name: meta.name ?? 'x',
          version: meta.version ?? null,
          iconUrl: meta.iconUrl ?? null,
          sizeBytes: 1,
        });
      },
      installToServer: () =>
        Promise.resolve({
          installedPath: '/x',
          filename: downloads.at(-1)?.meta.filename ?? 'file.jar',
        }),
    };
    const dbService = {
      db: {
        insert: () => ({
          values: (v: Record<string, unknown>) => {
            inserted.push(v);
            return { onConflictDoUpdate: () => Promise.resolve() };
          },
        }),
      },
    };

    mods = new ModsService(
      dbService as never,
      {} as never, // pathGuard: only used for pack-loader sniffing
      {
        assertUnderQuota: () => Promise.resolve(),
        scan: () => Promise.resolve(),
      } as never,
      { recordEvent: () => undefined } as never,
      library as never,
      {} as never, // modrinth
      {} as never, // curseforge
      new HangarApiService(cache),
      new SpigetApiService(cache),
      new GithubReleasesApiService(cache, config),
      { getServer: () => Promise.resolve(server) } as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  afterEach(() => fetchMock.mockRestore());

  describe('classifyModSource', () => {
    const kind = (input: string) => mods.classifyModSource(input).kind;

    it('routes the new registries by real hostname', () => {
      expect(kind('https://hangar.papermc.io/ViaVersion/ViaVersion')).toBe(
        'hangar',
      );
      expect(kind('https://www.spigotmc.org/resources/luckperms.28140/')).toBe(
        'spiget',
      );
      expect(kind('https://github.com/EssentialsX/Essentials/releases')).toBe(
        'github',
      );
      expect(kind('https://notgithub.com/EssentialsX/Essentials')).toBe(
        'direct',
      );
    });

    it('treats owner/repo as GitHub and still reads Modrinth slugs', () => {
      expect(kind('EssentialsX/Essentials')).toBe('github');
      expect(kind('sodium_extra')).toBe('modrinth');
      expect(kind('a/b/c')).toBe('invalid');
      expect(kind('owner/..')).toBe('invalid');
    });

    it('accepts links pasted without https://', () => {
      expect(kind('github.com/EssentialsX/Essentials')).toBe('github');
      expect(kind('hangar.papermc.io/ViaVersion/ViaVersion')).toBe('hangar');
      expect(kind('www.spigotmc.org/resources/luckperms.28140/')).toBe(
        'spiget',
      );
      expect(mods.classifyModSource('modrinth.com/mod/sodium').ref).toBe(
        'https://modrinth.com/mod/sodium',
      );
    });

    it('keeps non-jar GitHub assets and non-repo GitHub URLs as direct downloads', () => {
      expect(
        kind('https://github.com/o/r/releases/download/v1/o-r-1.0.jar'),
      ).toBe('github');
      expect(
        kind('https://github.com/o/r/releases/download/v1/datapack.zip'),
      ).toBe('direct');
      expect(kind('https://github.com/EssentialsX')).toBe('direct');
      expect(kind('https://example.com/some.jar')).toBe('direct');
    });
  });

  describe('Hangar', () => {
    const versionsFixture =
      (list: unknown[]): Route =>
      (url) =>
        url.pathname === '/api/v1/projects/ViaVersion/versions'
          ? Response.json({ result: list })
          : null;
    const projectRoute: Route = (url) =>
      url.pathname === '/api/v1/projects/ViaVersion'
        ? Response.json(hangarProject)
        : null;

    it('prefers the newest release over newer snapshots and verifies sha256', async () => {
      routes.push(
        projectRoute,
        versionsFixture([
          hangarVersion('5.1.0-SNAPSHOT+2', ['1.21'], { channel: 'Snapshot' }),
          hangarVersion('5.1.0-SNAPSHOT+1', ['1.21'], { channel: 'Snapshot' }),
          hangarVersion('5.0.9', ['1.20.6']), // release, wrong MC
          hangarVersion('5.0.0', ['1.21']),
        ]),
      );
      await install('https://hangar.papermc.io/ViaVersion/ViaVersion');
      expect(downloads).toHaveLength(1);
      expect(downloads[0]!.url).toBe(
        'https://hangarcdn.papermc.io/ViaVersion-5.0.0.jar',
      );
      expect(downloads[0]!.meta).toMatchObject({
        category: 'plugin',
        platform: 'hangar',
        projectId: 'ViaVersion',
        fileId: '5.0.0',
        version: '5.0.0',
        filename: 'ViaVersion-5.0.0.jar',
        expectedHash: { algorithm: 'sha256', hex: SHA },
      });
      expect(inserted[0]).toMatchObject({
        managedBy: 'overlay',
        kind: 'plugin',
      });
    });

    it('falls back to the newest snapshot when no release fits', async () => {
      routes.push(
        projectRoute,
        versionsFixture([
          hangarVersion('5.1.0-SNAPSHOT+2', ['1.21'], { channel: 'Snapshot' }),
        ]),
      );
      await install('https://hangar.papermc.io/ViaVersion/ViaVersion');
      expect(downloads[0]!.meta.version).toBe('5.1.0-SNAPSHOT+2');
    });

    it('installs a version pinned in the URL via its own endpoint', async () => {
      routes.push(projectRoute, (url) =>
        url.pathname === '/api/v1/projects/ViaVersion/versions/4.0.0'
          ? Response.json(hangarVersion('4.0.0', ['1.20']))
          : null,
      );
      await install(
        'https://hangar.papermc.io/ViaVersion/ViaVersion/versions/4.0.0',
      );
      expect(downloads[0]!.meta.version).toBe('4.0.0');
      expect(fetchedPaths()).not.toContain(
        '/api/v1/projects/ViaVersion/versions',
      );
    });

    it('409s an externally-hosted build instead of downloading it', async () => {
      routes.push(
        projectRoute,
        versionsFixture([hangarVersion('5.0.0', ['1.21'], { hosted: false })]),
      );
      const err = await install(
        'https://hangar.papermc.io/ViaVersion/ViaVersion',
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as Error).message).toContain(
        'https://github.com/ViaVersion/ViaVersion/releases',
      );
      expect(downloads).toHaveLength(0);
    });

    it('404s when no build matches the server', async () => {
      routes.push(
        projectRoute,
        versionsFixture([hangarVersion('5.0.9', ['1.20.6'])]),
      );
      await expect(
        install('https://hangar.papermc.io/ViaVersion/ViaVersion'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses plugin registries on a mod-loader server before any network call', async () => {
      server.type = 'FABRIC';
      await expect(
        install('https://hangar.papermc.io/ViaVersion/ViaVersion'),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        install('https://www.spigotmc.org/resources/luckperms.28140/'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('Spiget', () => {
    const resourceRoute =
      (opts: { external?: boolean; premium?: boolean } = {}): Route =>
      (url) =>
        url.pathname === '/v2/resources/28140'
          ? Response.json(spigetResource(opts))
          : null;

    it('downloads the newest version through the proxy, with no hash', async () => {
      routes.push(resourceRoute(), (url) =>
        url.pathname === '/v2/resources/28140/versions'
          ? Response.json([
              { id: 648014, name: '5.5.71', releaseDate: 1786045114 },
              { id: 590885, name: '5.5.0', releaseDate: 1748247660 },
            ])
          : null,
      );
      await install('https://www.spigotmc.org/resources/luckperms.28140/');
      expect(downloads[0]!.url).toBe(
        'https://api.spiget.org/v2/resources/28140/versions/648014/download/proxy',
      );
      expect(downloads[0]!.meta).toMatchObject({
        platform: 'spiget',
        projectId: '28140',
        fileId: '648014',
        version: '5.5.71',
        filename: 'LuckPerms-5.5.71.jar',
        mcVersions: ['1.20', '1.21'],
      });
      expect(downloads[0]!.meta.expectedHash).toBeUndefined();
    });

    it('installs a ?version= pin via the single-version endpoint', async () => {
      routes.push(resourceRoute(), (url) =>
        url.pathname === '/v2/resources/28140/versions/100'
          ? Response.json({ id: 100, name: '4.0.0', releaseDate: 1 })
          : null,
      );
      await install(
        'https://www.spigotmc.org/resources/luckperms.28140/?version=100',
      );
      expect(downloads[0]!.url).toBe(
        'https://api.spiget.org/v2/resources/28140/versions/100/download/proxy',
      );
      expect(downloads[0]!.meta.version).toBe('4.0.0');
    });

    it('409s an external resource, pointing at where it is hosted', async () => {
      routes.push(resourceRoute({ external: true }));
      const err = await install(
        'https://www.spigotmc.org/resources/luckperms.28140/',
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as Error).message).toMatch(/hosted outside SpigotMC/);
      expect((err as Error).message).toContain(
        'https://github.com/LuckPerms/LuckPerms/releases',
      );
      expect(downloads).toHaveLength(0);
    });

    it('409s a premium resource with its page URL', async () => {
      routes.push(resourceRoute({ premium: true }));
      const err = await install(
        'https://www.spigotmc.org/resources/luckperms.28140/',
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as Error).message).toMatch(/premium/);
      expect((err as Error).message).toContain(
        'https://www.spigotmc.org/resources/28140/',
      );
      expect(downloads).toHaveLength(0);
    });
  });

  describe('GitHub Releases', () => {
    const repoRoute: Route = (url) =>
      url.pathname === '/repos/EssentialsX/Essentials'
        ? Response.json(ghRepo)
        : null;
    const releasesRoute =
      (list: unknown[]): Route =>
      (url) =>
        url.pathname === '/repos/EssentialsX/Essentials/releases'
          ? Response.json(list)
          : null;

    it('installs the newest stable release, skipping sidecar jars, with the asset digest', async () => {
      routes.push(
        repoRoute,
        releasesRoute([
          ghRelease('2.22.0-dev', ['EssentialsX-2.22.0-dev.jar'], {
            prerelease: true,
          }),
          ghRelease('2.21.0', [
            'EssentialsX-2.21.0-sources.jar',
            'EssentialsX-2.21.0.jar',
          ]),
        ]),
      );
      await install('EssentialsX/Essentials');
      expect(downloads[0]!.url).toBe(
        'https://github.com/EssentialsX/Essentials/releases/download/2.21.0/EssentialsX-2.21.0.jar',
      );
      expect(downloads[0]!.meta).toMatchObject({
        platform: 'github',
        projectId: 'EssentialsX/Essentials',
        fileId: '2.21.0',
        version: '2.21.0',
        name: 'Essentials',
        filename: 'EssentialsX-2.21.0.jar',
        expectedHash: { algorithm: 'sha256', hex: SHA },
      });
    });

    it('installs exactly the asset a download link names', async () => {
      routes.push(
        repoRoute,
        releasesRoute([
          ghRelease('2.21.0', [
            'EssentialsX-2.21.0.jar',
            'EssentialsXChat-2.21.0.jar',
          ]),
        ]),
      );
      await install(
        'https://github.com/EssentialsX/Essentials/releases/download/2.21.0/EssentialsXChat-2.21.0.jar',
      );
      expect(downloads[0]!.meta.filename).toBe('EssentialsXChat-2.21.0.jar');
    });

    it('404s a download link whose asset is not in the release', async () => {
      routes.push(
        repoRoute,
        releasesRoute([ghRelease('2.21.0', ['EssentialsX-2.21.0.jar'])]),
      );
      await expect(
        install(
          'https://github.com/EssentialsX/Essentials/releases/download/2.21.0/Other.jar',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(downloads).toHaveLength(0);
    });

    it('404s an unknown pinned tag', async () => {
      routes.push(
        repoRoute,
        releasesRoute([ghRelease('2.21.0', ['EssentialsX-2.21.0.jar'])]),
      );
      await expect(
        install('https://github.com/EssentialsX/Essentials/releases/tag/1.0'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('leaves the hash unset for assets that predate digests', async () => {
      routes.push(
        repoRoute,
        releasesRoute([
          ghRelease('2.21.0', ['EssentialsX-2.21.0.jar'], { digest: false }),
        ]),
      );
      await install('EssentialsX/Essentials');
      expect(downloads[0]!.meta.expectedHash).toBeNull();
    });
  });
});
