import { Test } from '@nestjs/testing';
import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { ApiCacheService } from './api-cache.service';
import { SpigetApiService, parseSpigetRef } from './spiget-api.service';

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

const resource = (overrides: Record<string, unknown> = {}) => ({
  id: 28140,
  name: 'LuckPerms',
  tag: 'A permissions plugin',
  downloads: 8779542,
  icon: { url: 'data/resource_icons/28/28140.jpg?1490821714', data: 'iVBOR' },
  testedVersions: ['1.20', '1.21'],
  external: false,
  premium: false,
  file: { type: '.jar', url: 'resources/luckperms.28140/download' },
  description: 'PGRpdj4=',
  ...overrides,
});

describe('parseSpigetRef', () => {
  it('reads bare ids and SpigotMC name.id tails', () => {
    expect(parseSpigetRef('28140')).toEqual({
      resourceId: 28140,
      versionId: null,
    });
    expect(parseSpigetRef('luckperms.28140')).toEqual({
      resourceId: 28140,
      versionId: null,
    });
  });

  it('reads resource page URLs, including a pinned ?version=', () => {
    expect(
      parseSpigetRef('https://www.spigotmc.org/resources/luckperms.28140/'),
    ).toEqual({ resourceId: 28140, versionId: null });
    expect(
      parseSpigetRef('https://spigotmc.org/resources/28140/updates'),
    ).toEqual({ resourceId: 28140, versionId: null });
    expect(
      parseSpigetRef('https://www.spigotmc.org/resources/28140?version=555'),
    ).toEqual({ resourceId: 28140, versionId: '555' });
  });

  it('rejects other hosts, non-resource paths and version-like strings', () => {
    expect(parseSpigetRef('https://example.com/resources/28140')).toBeNull();
    expect(
      parseSpigetRef('https://www.spigotmc.org/threads/x.123/'),
    ).toBeNull();
    expect(parseSpigetRef('1.21')).toBeNull();
    expect(parseSpigetRef('luckperms')).toBeNull();
  });
});

describe('SpigetApiService', () => {
  let service: SpigetApiService;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  const calledUrl = (call: number): string => {
    const input = fetchMock.mock.calls[call]![0];
    return input instanceof Request ? input.url : input.toString();
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        SpigetApiService,
        { provide: ApiCacheService, useValue: new FakeApiCache() },
      ],
    }).compile();
    service = moduleRef.get(SpigetApiService);
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => fetchMock.mockRestore());

  it('resolveUrl normalizes the resource and carries the pinned version', async () => {
    fetchMock.mockResolvedValue(Response.json(resource()));
    const resolved = await service.resolveUrl(
      'https://www.spigotmc.org/resources/luckperms.28140/?version=648014',
    );
    expect(calledUrl(0)).toBe('https://api.spiget.org/v2/resources/28140');
    expect(resolved).toEqual({
      resourceId: 28140,
      name: 'LuckPerms',
      tag: 'A permissions plugin',
      downloads: 8779542,
      iconUrl:
        'https://www.spigotmc.org/data/resource_icons/28/28140.jpg?1490821714',
      testedVersions: ['1.20', '1.21'],
      external: false,
      premium: false,
      pageUrl: 'https://www.spigotmc.org/resources/28140/',
      versionId: '648014',
    });
  });

  it('flags external and premium resources', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(resource({ external: true, file: { type: 'external' } })),
    );
    expect((await service.getResource(1)).external).toBe(true);
    fetchMock.mockResolvedValueOnce(Response.json(resource({ premium: true })));
    expect((await service.getResource(2)).premium).toBe(true);
  });

  it('resolveUrl rejects unparseable input without calling Spiget', async () => {
    await expect(service.resolveUrl('not-a-resource')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getVersions sorts by id and converts unix-second release dates', async () => {
    fetchMock.mockResolvedValue(
      Response.json([
        { id: 648014, name: '5.5.71', releaseDate: 1786045114, downloads: 1 },
        { id: 590885, name: null, releaseDate: null },
      ]),
    );
    const versions = await service.getVersions(28140);
    const url = new URL(calledUrl(0));
    expect(url.pathname).toBe('/v2/resources/28140/versions');
    expect(url.searchParams.get('sort')).toBe('-id');
    expect(versions).toEqual([
      {
        versionId: '648014',
        name: '5.5.71',
        datePublished: new Date(1786045114 * 1000).toISOString(),
      },
      { versionId: '590885', name: '590885', datePublished: null },
    ]);
  });

  it('search treats Spiget’s empty-result 404 as no hits', async () => {
    fetchMock.mockResolvedValue(Response.json([], { status: 404 }));
    await expect(service.search({ query: 'zzqqxx' })).resolves.toEqual([]);
  });

  it('search skips the network for a blank query', async () => {
    await expect(service.search({ query: '  ' })).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('builds proxy download URLs and rejects non-numeric ids', () => {
    expect(service.downloadUrl(28140, '648014')).toBe(
      'https://api.spiget.org/v2/resources/28140/versions/648014/download/proxy',
    );
    expect(service.downloadUrl(28140)).toBe(
      'https://api.spiget.org/v2/resources/28140/versions/latest/download/proxy',
    );
    expect(() => service.downloadUrl(28140, '../x')).toThrow(
      BadRequestException,
    );
  });

  it('rejects an unexpected response shape as a bad gateway', async () => {
    fetchMock.mockResolvedValue(Response.json({ id: 'nope' }));
    await expect(service.getResource(28140)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});
