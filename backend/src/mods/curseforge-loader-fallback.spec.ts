import { CurseforgeApiService } from './curseforge-api.service';
import type { ApiCacheService } from './api-cache.service';
import type { ApiKeysService } from '../api-keys/api-keys.service';

const file = (id: number) => ({
  id,
  displayName: `f${id}`,
  fileName: `f${id}.jar`,
  fileDate: '2026-01-01T00:00:00Z',
  fileLength: 1,
  gameVersions: ['1.21.1'],
});

describe('CurseforgeApiService loader fallback', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let urls: URL[];
  let byLoader: Record<string, number[]>;
  let service: CurseforgeApiService;

  beforeEach(() => {
    urls = [];
    byLoader = {};
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation((input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      urls.push(url);
      const ids = byLoader[url.searchParams.get('modLoaderType') ?? ''] ?? [];
      return Promise.resolve(
        Response.json({ data: ids.map(file), pagination: { totalCount: 0 } }),
      );
    });
    const cache = {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
    } as unknown as ApiCacheService;
    const keys = {
      getKey: () => Promise.resolve('k'),
    } as unknown as ApiKeysService;
    service = new CurseforgeApiService(cache, keys);
  });
  afterEach(() => fetchMock.mockRestore());

  it('lists a quilt server quilt files first, then fabric ones, deduplicated', async () => {
    byLoader = { '5': [10, 12], '4': [13, 12, 11] }; // 4 = fabric, 5 = quilt
    const files = await service.getFiles(1, { loader: 'quilt' });
    expect(files.map((f) => f.fileId)).toEqual([10, 12, 13, 11]);
    expect(urls.map((u) => u.searchParams.get('modLoaderType')).sort()).toEqual(
      ['4', '5'],
    );
  });

  it('falls back to fabric files alone when quilt has none', async () => {
    byLoader = { '4': [7, 6] };
    const files = await service.getFiles(1, { loader: 'quilt' });
    expect(files.map((f) => f.fileId)).toEqual([7, 6]);
  });

  it('makes one request for a loader without fallbacks', async () => {
    byLoader = { '4': [1] };
    await service.getFiles(1, { loader: 'fabric' });
    expect(urls).toHaveLength(1);
    expect(urls[0]!.searchParams.get('modLoaderType')).toBe('4');
  });

  it('searches quilt as an OR-list of loader types', async () => {
    await service.search({ query: 'x', loader: 'quilt' });
    expect(urls[0]!.searchParams.get('modLoaderTypes')).toBe('[5,4]');
    expect(urls[0]!.searchParams.has('modLoaderType')).toBe(false);
  });

  it('searches other loaders with a single type', async () => {
    await service.search({ query: 'x', loader: 'forge' });
    expect(urls[0]!.searchParams.get('modLoaderType')).toBe('1');
  });
});
