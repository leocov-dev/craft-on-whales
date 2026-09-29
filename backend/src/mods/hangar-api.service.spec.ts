import { Test } from '@nestjs/testing';
import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { ApiCacheService } from './api-cache.service';
import {
  HangarApiService,
  hangarCompatibleWith,
  hangarExpectedHash,
  parseHangarRef,
} from './hangar-api.service';

// In-memory stand-in for the api_cache table; ageMs is settable per row.
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

const project = {
  name: 'ViaVersion',
  namespace: { owner: 'ViaVersion', slug: 'ViaVersion' },
  description: 'Allow newer clients to connect',
  avatarUrl: 'https://hangarcdn.papermc.io/avatars/project/31.webp',
  stats: { downloads: 499736 },
};

const version = (
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
  platformDependencies: { PAPER: mc, VELOCITY: ['3.4'] },
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
          externalUrl: 'https://example.org/download',
        },
  },
});

describe('parseHangarRef', () => {
  it('reads project page URLs, with and without a pinned version', () => {
    expect(
      parseHangarRef('https://hangar.papermc.io/ViaVersion/ViaVersion'),
    ).toEqual({ slug: 'ViaVersion', versionName: null });
    expect(
      parseHangarRef(
        'https://hangar.papermc.io/ViaVersion/ViaVersion/versions/5.12.1-SNAPSHOT%2B1074',
      ),
    ).toEqual({ slug: 'ViaVersion', versionName: '5.12.1-SNAPSHOT+1074' });
    expect(parseHangarRef('hangar.papermc.io/ViaVersion/ViaVersion/')).toEqual({
      slug: 'ViaVersion',
      versionName: null,
    });
  });

  it('reads owner/slug and bare slugs', () => {
    expect(parseHangarRef('ViaVersion/ViaVersion')).toEqual({
      slug: 'ViaVersion',
      versionName: null,
    });
    expect(parseHangarRef('ViaVersion')).toEqual({
      slug: 'ViaVersion',
      versionName: null,
    });
  });

  it('rejects other hosts and malformed input', () => {
    expect(parseHangarRef('https://nothangar.papermc.io/a/b')).toBeNull();
    expect(parseHangarRef('https://hangar.papermc.io/onlyowner')).toBeNull();
    expect(parseHangarRef('a/b/c')).toBeNull();
    expect(parseHangarRef('..')).toBeNull();
    expect(parseHangarRef('not a slug')).toBeNull();
  });
});

describe('hangarCompatibleWith', () => {
  it('matches exact and bare-minor tags', () => {
    expect(hangarCompatibleWith(['1.21', '1.20.6'], '1.21.4')).toBe(true);
    expect(hangarCompatibleWith(['1.21.4'], '1.21.4')).toBe(true);
    expect(hangarCompatibleWith(['1.20.6'], '1.21.4')).toBe(false);
  });

  it('never lets "1.2" prefix-match "1.21"', () => {
    expect(hangarCompatibleWith(['1.2'], '1.21.5')).toBe(false);
    expect(hangarCompatibleWith(['1.21'], '1.2.5')).toBe(false);
  });
});

describe('HangarApiService', () => {
  let service: HangarApiService;
  let cache: FakeApiCache;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  const calledUrl = (call: number): string => {
    const input = fetchMock.mock.calls[call]![0];
    return input instanceof Request ? input.url : input.toString();
  };

  beforeEach(async () => {
    cache = new FakeApiCache();
    const moduleRef = await Test.createTestingModule({
      providers: [
        HangarApiService,
        { provide: ApiCacheService, useValue: cache },
      ],
    }).compile();
    service = moduleRef.get(HangarApiService);
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => fetchMock.mockRestore());

  it('resolveUrl fetches the project by slug and carries the pinned version', async () => {
    fetchMock.mockResolvedValue(Response.json(project));
    const resolved = await service.resolveUrl(
      'https://hangar.papermc.io/ViaVersion/ViaVersion/versions/5.0.0',
    );
    expect(calledUrl(0)).toBe(
      'https://hangar.papermc.io/api/v1/projects/ViaVersion',
    );
    expect(resolved).toEqual({
      slug: 'ViaVersion',
      owner: 'ViaVersion',
      name: 'ViaVersion',
      description: 'Allow newer clients to connect',
      iconUrl: 'https://hangarcdn.papermc.io/avatars/project/31.webp',
      downloads: 499736,
      versionName: '5.0.0',
    });
  });

  it('resolveUrl rejects input it cannot parse without calling Hangar', async () => {
    await expect(service.resolveUrl('a/b/c')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getVersions normalizes PAPER builds and filters by MC version', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        result: [
          version('5.1.0-SNAPSHOT', ['1.21'], { channel: 'Snapshot' }),
          version('5.0.0', ['1.21', '1.20.6']),
          version('4.0.0', ['1.20.4']),
          version('3.0.0', [], { hosted: false }),
        ],
      }),
    );
    const versions = await service.getVersions('ViaVersion', {
      mcVersion: '1.21.4',
    });
    const url = new URL(calledUrl(0));
    expect(url.pathname).toBe('/api/v1/projects/ViaVersion/versions');
    expect(url.searchParams.get('platform')).toBe('PAPER');
    expect(versions.map((v) => v.name)).toEqual([
      '5.1.0-SNAPSHOT',
      '5.0.0',
      '3.0.0',
    ]);
    expect(versions[0]!.versionType).toBe('alpha');
    expect(versions[1]).toMatchObject({
      versionType: 'release',
      gameVersions: ['1.21', '1.20.6'],
      downloadUrl: 'https://hangarcdn.papermc.io/ViaVersion-5.0.0.jar',
      external: false,
      filename: 'ViaVersion-5.0.0.jar',
      sha256: 'e'.repeat(64),
    });
    expect(hangarExpectedHash(versions[1]!)).toEqual({
      algorithm: 'sha256',
      hex: 'e'.repeat(64),
    });
    // Externally-hosted: no Hangar file, so no hash to verify against.
    expect(versions[2]).toMatchObject({
      downloadUrl: null,
      externalUrl: 'https://example.org/download',
      external: true,
      sha256: null,
    });
    expect(hangarExpectedHash(versions[2]!)).toBeNull();
  });

  it('serves a fresh cache hit without refetching', async () => {
    fetchMock.mockResolvedValue(Response.json(project));
    await service.getProject('ViaVersion');
    await service.getProject('ViaVersion');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to a stale cache row when rate-limited', async () => {
    fetchMock.mockResolvedValueOnce(Response.json(project));
    await service.getProject('ViaVersion');
    for (const row of cache.rows.values()) row.ageMs = 24 * 60 * 60 * 1000;
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 429 }));
    await expect(service.getProject('ViaVersion')).resolves.toMatchObject({
      slug: 'ViaVersion',
    });
  });

  it('rejects an unexpected response shape as a bad gateway', async () => {
    fetchMock.mockResolvedValue(Response.json({ name: 'x' }));
    await expect(service.getProject('ViaVersion')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(cache.rows.size).toBe(0);
  });
});
