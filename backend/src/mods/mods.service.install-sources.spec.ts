import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ModsService } from './mods.service';
import { BlockedDownloadException } from './blocked-download.exception';
import { CurseforgeApiService } from './curseforge-api.service';
import { HangarApiService } from './hangar-api.service';
import { SpigetApiService } from './spiget-api.service';
import { GithubReleasesApiService } from './github-releases-api.service';
import type { ApiCacheService } from './api-cache.service';
import type { ConfigService } from '../config/config.service';
import type { ApiKeysService } from '../api-keys/api-keys.service';
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

// --- CurseForge fixtures --------------------------------------------------

const JAR_BYTES = Buffer.from('pretend this is a jar');
const JAR_SHA1 = crypto.createHash('sha1').update(JAR_BYTES).digest('hex');

const cfMod = {
  id: 238222,
  slug: 'jei',
  name: 'Just Enough Items',
  summary: 'x',
  logo: { thumbnailUrl: 'https://media.forgecdn.net/jei.png' },
  downloadCount: 1,
  classId: 6,
};

const cfFile = (id: number, { distributable = true } = {}) => ({
  id,
  displayName: `jei-1.21.1-fabric-${id}`,
  fileName: `jei-1.21.1-fabric-${id}.jar`,
  // CurseForge's API gives no downloadUrl when the author disallows
  // third-party downloads (allowModDistribution: false).
  downloadUrl: distributable
    ? `https://edge.forgecdn.net/files/${id}/jei.jar`
    : null,
  gameVersions: ['1.21.1', 'Fabric'],
  releaseType: 1,
  fileDate: '2026-08-01T00:00:00Z',
  fileLength: JAR_BYTES.length,
  hashes: [
    { value: JAR_SHA1, algo: 1 },
    { value: 'f'.repeat(32), algo: 2 },
  ],
});

describe('ModsService — Hangar / Spiget / GitHub sources', () => {
  let mods: ModsService;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let routes: Route[];
  let server: { id: string; type: string; mc_version: string; env: object };
  let downloads: { url: string; meta: DownloadMeta }[];
  let inserted: Record<string, unknown>[];
  let imported: { path: string; meta: DownloadMeta }[];
  let provenance: DownloadMeta[];
  let linked: { serverId: string; dir: string }[];

  const install = (input: string) =>
    mods.installFromUrl('srv1', input, { actor: 'test' });
  /** The `blocked` payload of a 409, as the exception filter would send it. */
  const blockedBody = (err: unknown) => {
    expect(err).toBeInstanceOf(BlockedDownloadException);
    return (
      (err as BlockedDownloadException).getResponse() as { blocked: unknown }
    ).blocked;
  };
  const fetchedPaths = () =>
    fetchMock.mock.calls.map(([u]) => toUrl(u).pathname);

  beforeEach(() => {
    routes = [];
    downloads = [];
    inserted = [];
    imported = [];
    provenance = [];
    linked = [];
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
      importFile: (p: string, meta: DownloadMeta) => {
        imported.push({ path: p, meta });
        return Promise.resolve({
          id: 'lib2',
          name: meta.name ?? 'x',
          filename: meta.filename ?? 'x.jar',
          version: meta.version ?? null,
          iconUrl: null,
          sizeBytes: 1,
          projectId: null,
        });
      },
      fillMissingProvenance: (_id: string, meta: DownloadMeta) => {
        provenance.push(meta);
        return Promise.resolve({
          id: 'lib2',
          name: meta.name ?? 'x',
          version: meta.version ?? null,
          iconUrl: meta.iconUrl ?? null,
          sizeBytes: 1,
          projectId: meta.projectId ?? null,
        });
      },
      installToServer: (_lib: string, serverId: string, dir: string) => {
        linked.push({ serverId, dir });
        return Promise.resolve({
          installedPath: '/x',
          filename:
            imported.at(-1)?.meta.filename ??
            downloads.at(-1)?.meta.filename ??
            'file.jar',
        });
      },
    };
    const apiKeys = {
      getKey: () => Promise.resolve('cf-test-key'),
    } as unknown as ApiKeysService;
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
      new CurseforgeApiService(cache, apiKeys),
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
      expect(blockedBody(err)).toEqual({
        source: 'hangar',
        reason: 'external',
        name: 'ViaVersion',
        version: '5.0.0',
        filename: null,
        pageUrl:
          'https://hangar.papermc.io/ViaVersion/ViaVersion/versions/5.0.0',
        externalUrl: 'https://github.com/ViaVersion/ViaVersion/releases',
        verifiable: false,
      });
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
      expect((err as Error).message).toMatch(/isn't hosted on SpigotMC/);
      expect((err as Error).message).toContain(
        'https://github.com/LuckPerms/LuckPerms/releases',
      );
      expect(blockedBody(err)).toEqual({
        source: 'spiget',
        reason: 'external',
        name: 'LuckPerms',
        version: null, // no versions route: the failed lookup doesn't hide the block
        filename: null,
        pageUrl: 'https://www.spigotmc.org/resources/28140/',
        externalUrl: 'https://github.com/LuckPerms/LuckPerms/releases',
        verifiable: false,
      });
      expect(downloads).toHaveLength(0);
    });

    it('409s a premium resource with its page URL and newest version', async () => {
      routes.push(resourceRoute({ premium: true }), (url) =>
        url.pathname === '/v2/resources/28140/versions'
          ? Response.json([{ id: 648014, name: '5.5.71', releaseDate: 1 }])
          : null,
      );
      const err = await install(
        'https://www.spigotmc.org/resources/luckperms.28140/',
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as Error).message).toMatch(/premium/);
      expect((err as Error).message).toContain(
        'https://www.spigotmc.org/resources/28140/',
      );
      expect(blockedBody(err)).toMatchObject({
        source: 'spiget',
        reason: 'premium',
        version: '5.5.71',
        externalUrl: null,
      });
      expect((err as BlockedDownloadException).meta).toMatchObject({
        platform: 'spiget',
        projectId: '28140',
        fileId: '648014',
      });
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
  describe('CurseForge', () => {
    const PINNED =
      'https://www.curseforge.com/minecraft/mc-mods/jei/files/5001';
    const cfRoutes = (files: unknown[]): Route[] => [
      (url) =>
        url.host === 'api.curseforge.com' && url.pathname === '/v1/mods/search'
          ? Response.json({ data: [cfMod] })
          : null,
      (url) =>
        url.pathname === '/v1/mods/238222/files'
          ? Response.json({ data: files })
          : null,
      (url) => {
        const m = /^\/v1\/mods\/238222\/files\/(\d+)$/.exec(url.pathname);
        const file = m
          ? (files as { id: number }[]).find((f) => f.id === Number(m[1]))
          : undefined;
        return file ? Response.json({ data: file }) : null;
      },
    ];

    beforeEach(() => {
      server.type = 'FABRIC';
      server.mc_version = '1.21.1';
    });

    it('returns a structured block for a file whose author disallows third-party downloads', async () => {
      routes.push(...cfRoutes([cfFile(5001, { distributable: false })]));
      const err = await install(PINNED).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as Error).message).toMatch(/disallows automated downloads/);
      expect(blockedBody(err)).toEqual({
        source: 'curseforge',
        reason: 'distribution-disabled',
        name: 'Just Enough Items',
        version: 'jei-1.21.1-fabric-5001',
        filename: 'jei-1.21.1-fabric-5001.jar',
        pageUrl: PINNED,
        externalUrl: null,
        verifiable: true,
      });
      expect(downloads).toHaveLength(0);
    });

    it('blocks on the newest matching file rather than silently installing an older one', async () => {
      routes.push(
        ...cfRoutes([cfFile(5002, { distributable: false }), cfFile(5001)]),
      );
      const err = await install(
        'https://www.curseforge.com/minecraft/mc-mods/jei',
      ).catch((e: unknown) => e);
      expect(blockedBody(err)).toMatchObject({
        version: 'jei-1.21.1-fabric-5002',
        pageUrl: 'https://www.curseforge.com/minecraft/mc-mods/jei/files/5002',
      });
      expect(downloads).toHaveLength(0);
    });

    it('assertResolvable surfaces the block without installing (update preflight)', async () => {
      routes.push(...cfRoutes([cfFile(5001, { distributable: false })]));
      await expect(
        mods.assertResolvable('srv1', PINNED),
      ).rejects.toBeInstanceOf(BlockedDownloadException);
      expect(downloads).toHaveLength(0);
      expect(inserted).toHaveLength(0);
    });

    it('downloads a distributable file with its sha1', async () => {
      routes.push(...cfRoutes([cfFile(5001)]));
      await install(PINNED);
      expect(downloads[0]!.url).toBe(
        'https://edge.forgecdn.net/files/5001/jei.jar',
      );
      expect(downloads[0]!.meta).toMatchObject({
        platform: 'curseforge',
        projectId: '238222',
        fileId: '5001',
        expectedHash: { algorithm: 'sha1', hex: JAR_SHA1 },
      });
    });
  });

  describe('installManualUpload (blocked-download fallback)', () => {
    let dir: string;
    let jar: string;
    const upload = (name: string, input: string) =>
      mods.installManualUpload('srv1', jar, name, input, { actor: 'test' });

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-upload-'));
      jar = path.join(dir, 'upload.tmp');
      fs.writeFileSync(jar, JAR_BYTES);
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    describe('CurseForge', () => {
      const PINNED =
        'https://www.curseforge.com/minecraft/mc-mods/jei/files/5001';
      beforeEach(() => {
        server.type = 'FABRIC';
        server.mc_version = '1.21.1';
        routes.push(
          (url) =>
            url.pathname === '/v1/mods/search'
              ? Response.json({ data: [cfMod] })
              : null,
          (url) =>
            url.pathname === '/v1/mods/238222/files/5001'
              ? Response.json({
                  data: cfFile(5001, { distributable: false }),
                })
              : null,
        );
      });

      it('installs a jar matching the blocked file’s sha1 with full provenance', async () => {
        const res = await upload('jei-1.21.1-fabric-5001 (1).jar', PINNED);
        expect(res.verified).toBe(true);
        expect(imported).toEqual([
          {
            path: jar,
            meta: expect.objectContaining({
              category: 'mod',
              name: 'Just Enough Items',
              // The registry's name, not the browser's "(1)" copy.
              filename: 'jei-1.21.1-fabric-5001.jar',
              version: 'jei-1.21.1-fabric-5001',
            }) as unknown,
          },
        ]);
        expect(provenance[0]).toMatchObject({
          platform: 'curseforge',
          projectId: '238222',
          fileId: '5001',
        });
        expect(linked).toEqual([{ serverId: 'srv1', dir: 'mods' }]);
        expect(inserted[0]).toMatchObject({
          serverId: 'srv1',
          libraryId: 'lib2',
          kind: 'mod',
          managedBy: 'overlay',
        });
        expect(downloads).toHaveLength(0);
      });

      it('rejects a jar that is not the blocked file, before touching the library', async () => {
        fs.writeFileSync(jar, 'some other jar');
        const err = await upload('jei.jar', PINNED).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as Error).message).toContain('jei-1.21.1-fabric-5001.jar');
        expect(imported).toHaveLength(0);
        expect(inserted).toHaveLength(0);
      });
    });

    it('installs an externally-hosted Hangar build as an unverified plugin with Hangar provenance', async () => {
      routes.push(
        (url) =>
          url.pathname === '/api/v1/projects/ViaVersion'
            ? Response.json(hangarProject)
            : null,
        (url) =>
          url.pathname === '/api/v1/projects/ViaVersion/versions'
            ? Response.json({
                result: [hangarVersion('5.0.0', ['1.21'], { hosted: false })],
              })
            : null,
      );
      const res = await upload(
        'ViaVersion-5.0.0.jar',
        'https://hangar.papermc.io/ViaVersion/ViaVersion',
      );
      expect(res.verified).toBe(false);
      expect(imported[0]!.meta).toMatchObject({
        category: 'plugin',
        filename: 'ViaVersion-5.0.0.jar',
        version: '5.0.0',
      });
      expect(provenance[0]).toMatchObject({
        platform: 'hangar',
        projectId: 'ViaVersion',
        fileId: '5.0.0',
      });
      expect(linked).toEqual([{ serverId: 'srv1', dir: 'plugins' }]);
      expect(inserted[0]).toMatchObject({ serverId: 'srv1', kind: 'plugin' });
    });

    it('installs a premium SpigotMC resource against its resolved version', async () => {
      routes.push(
        (url) =>
          url.pathname === '/v2/resources/28140'
            ? Response.json(spigetResource({ premium: true }))
            : null,
        (url) =>
          url.pathname === '/v2/resources/28140/versions'
            ? Response.json([{ id: 648014, name: '5.5.71', releaseDate: 1 }])
            : null,
      );
      const res = await upload(
        'LuckPerms-Bukkit-5.5.71.jar',
        'https://www.spigotmc.org/resources/luckperms.28140/',
      );
      expect(res.verified).toBe(false);
      expect(provenance[0]).toMatchObject({
        platform: 'spiget',
        projectId: '28140',
        fileId: '648014',
        version: '5.5.71',
      });
      expect(imported[0]!.meta.filename).toBe('LuckPerms-Bukkit-5.5.71.jar');
    });

    it('refuses non-jar files and plugin registries on mod servers before any lookup', async () => {
      await expect(
        upload('notes.txt', 'https://hangar.papermc.io/ViaVersion/ViaVersion'),
      ).rejects.toBeInstanceOf(BadRequestException);
      server.type = 'FABRIC';
      await expect(
        upload('x.jar', 'https://hangar.papermc.io/ViaVersion/ViaVersion'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(imported).toHaveLength(0);
    });

    it('passes through lookup failures other than a block', async () => {
      routes.push(
        (url) =>
          url.pathname === '/api/v1/projects/ViaVersion'
            ? Response.json(hangarProject)
            : null,
        (url) =>
          url.pathname === '/api/v1/projects/ViaVersion/versions'
            ? Response.json({ result: [] })
            : null,
      );
      await expect(
        upload('x.jar', 'https://hangar.papermc.io/ViaVersion/ViaVersion'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(imported).toHaveLength(0);
    });
  });
});

describe('BlockedDownloadException', () => {
  it('drops an externalUrl that is not http(s), since the UI renders it as a link', () => {
    const blocked = {
      source: 'hangar' as const,
      reason: 'external' as const,
      name: 'X',
      version: '1',
      filename: null,
      pageUrl: 'https://hangar.papermc.io/o/X/versions/1',
      externalUrl: 'javascript:alert(1)',
      verifiable: false,
    };
    const err = new BlockedDownloadException(blocked, {});
    expect(err.blocked.externalUrl).toBeNull();
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({
      statusCode: 409,
      blocked: { externalUrl: null, pageUrl: blocked.pageUrl },
    });
    expect(err.message).toContain(blocked.pageUrl);
  });
});
