import { Test } from '@nestjs/testing';
import {
  BadGatewayException,
  BadRequestException,
  HttpException,
} from '@nestjs/common';
import { ApiCacheService } from './api-cache.service';
import { ConfigService } from '../config/config.service';
import {
  GithubReleasesApiService,
  githubAssetExpectedHash,
  parseGithubRef,
  pickGithubAsset,
  pickGithubRelease,
} from './github-releases-api.service';
import type { GithubRelease, GithubReleaseAsset } from './mods.types';

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

const rawRelease = (
  tag: string,
  assets: string[],
  { prerelease = false, draft = false } = {},
) => ({
  tag_name: tag,
  name: null,
  draft,
  prerelease,
  published_at: '2026-05-31T15:00:46Z',
  html_url: `https://github.com/o/r/releases/tag/${tag}`,
  assets: assets.map((name) => ({
    name,
    size: 1,
    browser_download_url: `https://github.com/o/r/releases/download/${tag}/${name}`,
    digest: `sha256:${'A'.repeat(64)}`,
  })),
});

const asset = (name: string): GithubReleaseAsset => ({
  name,
  size: 1,
  downloadUrl: `https://example.invalid/${name}`,
  sha256: null,
});

const release = (
  tag: string,
  assets: string[],
  prerelease = false,
): GithubRelease => ({
  tag,
  name: tag,
  prerelease,
  publishedAt: null,
  htmlUrl: '',
  assets: assets.map(asset),
});

describe('parseGithubRef', () => {
  it('reads owner/repo and every GitHub URL shape people paste', () => {
    expect(parseGithubRef('EssentialsX/Essentials')).toEqual({
      repo: 'EssentialsX/Essentials',
      tag: null,
      asset: null,
    });
    expect(parseGithubRef('https://github.com/EssentialsX/Essentials')).toEqual(
      { repo: 'EssentialsX/Essentials', tag: null, asset: null },
    );
    expect(parseGithubRef('github.com/EssentialsX/Essentials.git')).toEqual({
      repo: 'EssentialsX/Essentials',
      tag: null,
      asset: null,
    });
    expect(
      parseGithubRef(
        'https://github.com/EssentialsX/Essentials/releases/tag/2.21.0',
      ),
    ).toEqual({ repo: 'EssentialsX/Essentials', tag: '2.21.0', asset: null });
    expect(
      parseGithubRef(
        'https://github.com/EssentialsX/Essentials/releases/download/2.21.0/EssentialsX-2.21.0.jar',
      ),
    ).toEqual({
      repo: 'EssentialsX/Essentials',
      tag: '2.21.0',
      asset: 'EssentialsX-2.21.0.jar',
    });
  });

  it('rejects non-GitHub or malformed input', () => {
    expect(parseGithubRef('https://github.com/onlyowner')).toBeNull();
    expect(parseGithubRef('https://notgithub.com/a/b')).toBeNull();
    expect(parseGithubRef('not a repo')).toBeNull();
    expect(parseGithubRef('../etc')).toBeNull();
    expect(parseGithubRef('a/b/c')).toBeNull();
  });
});

describe('pickGithubRelease / pickGithubAsset', () => {
  const releases = [
    release('v3-beta', ['x-3.jar'], true),
    release('v2', []),
    release('v1', ['x-1-sources.jar', 'x-1.jar']),
  ];

  it('prefers the newest stable release with jars', () => {
    expect(pickGithubRelease(releases)?.tag).toBe('v1');
  });

  it('falls back to a pre-release when nothing stable has jars', () => {
    expect(pickGithubRelease(releases.slice(0, 2))?.tag).toBe('v3-beta');
  });

  it('honours an explicit tag', () => {
    expect(pickGithubRelease(releases, 'v2')?.tag).toBe('v2');
    expect(pickGithubRelease(releases, 'nope')).toBeNull();
  });

  it('skips sidecar jars and honours a preferred asset name', () => {
    const assets = releases[2]!.assets;
    expect(pickGithubAsset(assets)?.name).toBe('x-1.jar');
    expect(pickGithubAsset(assets, 'x-1-sources.jar')?.name).toBe(
      'x-1-sources.jar',
    );
    expect(pickGithubAsset([])).toBeNull();
  });
});

describe('GithubReleasesApiService', () => {
  let service: GithubReleasesApiService;
  let cache: FakeApiCache;
  let config: { githubToken: string | null };
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  const calledUrl = (call: number): string => {
    const input = fetchMock.mock.calls[call]![0];
    return input instanceof Request ? input.url : input.toString();
  };

  const build = async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        GithubReleasesApiService,
        { provide: ApiCacheService, useValue: cache },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    service = moduleRef.get(GithubReleasesApiService);
  };

  const headersOf = (call: number) =>
    (fetchMock.mock.calls[call]![1] as RequestInit).headers as Record<
      string,
      string
    >;

  beforeEach(async () => {
    cache = new FakeApiCache();
    config = { githubToken: null };
    fetchMock = jest.spyOn(global, 'fetch');
    await build();
  });

  afterEach(() => fetchMock.mockRestore());

  it('getReleases drops drafts, keeps only jars, and parses sha256 digests', async () => {
    fetchMock.mockResolvedValue(
      Response.json([
        rawRelease('v2-draft', ['x.jar'], { draft: true }),
        rawRelease('v1', ['x-1.jar', 'x-1.zip']),
      ]),
    );
    const releases = await service.getReleases('o/r');
    expect(calledUrl(0)).toBe(
      'https://api.github.com/repos/o/r/releases?per_page=30',
    );
    expect(releases).toEqual([
      {
        tag: 'v1',
        name: 'v1',
        prerelease: false,
        publishedAt: '2026-05-31T15:00:46Z',
        htmlUrl: 'https://github.com/o/r/releases/tag/v1',
        assets: [
          {
            name: 'x-1.jar',
            size: 1,
            downloadUrl: 'https://github.com/o/r/releases/download/v1/x-1.jar',
            sha256: 'a'.repeat(64),
          },
        ],
      },
    ]);
    expect(githubAssetExpectedHash(releases[0]!.assets[0]!)).toEqual({
      algorithm: 'sha256',
      hex: 'a'.repeat(64),
    });
    expect(githubAssetExpectedHash(asset('old.jar'))).toBeNull();
  });

  it('revalidates with If-None-Match and serves a 304 from cache', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json([rawRelease('v1', ['x.jar'])], {
        headers: { etag: 'W/"abc123"' },
      }),
    );
    expect((await service.getReleases('o/r'))[0]!.tag).toBe('v1');
    // Age the row past its TTL so the client must revalidate.
    for (const row of cache.rows.values()) row.ageMs = 60 * 60 * 1000;
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 304 }));
    expect((await service.getReleases('o/r'))[0]!.tag).toBe('v1');
    expect(headersOf(1)['If-None-Match']).toBe('W/"abc123"');
    // The 304 restarted the TTL window.
    expect([...cache.rows.values()][0]!.ageMs).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends GITHUB_TOKEN as a bearer token only when configured', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        Response.json({ full_name: 'o/r', name: 'r', owner: null }),
      ),
    );
    await service.getRepo('o/r');
    expect(headersOf(0).Authorization).toBeUndefined();

    config = { githubToken: 'ghp_test' };
    cache = new FakeApiCache();
    await build();
    await service.getRepo('o/r');
    expect(headersOf(1).Authorization).toBe('Bearer ghp_test');
  });

  it('rate limiting with nothing cached is a 429 with reset + token hints', async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        {},
        {
          status: 403,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 120),
          },
        },
      ),
    );
    const err: unknown = await service
      .getReleases('o/fresh')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).message).toMatch(
      /resets in ~\d+ min.*GITHUB_TOKEN/,
    );
  });

  it('rate limiting falls back to a stale cache row', async () => {
    fetchMock.mockResolvedValueOnce(Response.json([rawRelease('v1', [])]));
    await service.getReleases('o/r');
    for (const row of cache.rows.values()) row.ageMs = 24 * 60 * 60 * 1000;
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 429 }));
    expect((await service.getReleases('o/r'))[0]!.tag).toBe('v1');
  });

  it('resolveUrl returns the canonical repo plus any pinned tag/asset', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        full_name: 'EssentialsX/Essentials',
        name: 'Essentials',
        description: null,
        owner: { avatar_url: 'https://avatars.githubusercontent.com/u/1' },
      }),
    );
    await expect(
      service.resolveUrl(
        'https://github.com/essentialsx/essentials/releases/tag/2.22.0',
      ),
    ).resolves.toEqual({
      repo: 'EssentialsX/Essentials',
      name: 'Essentials',
      description: '',
      iconUrl: 'https://avatars.githubusercontent.com/u/1',
      tag: '2.22.0',
      asset: null,
    });
    await expect(service.resolveUrl('nope')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects an unexpected response shape as a bad gateway', async () => {
    fetchMock.mockResolvedValue(Response.json({ not: 'a repo' }));
    await expect(service.getRepo('o/r')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});
