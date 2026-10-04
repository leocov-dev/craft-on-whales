import { CurseforgeApiService } from './curseforge-api.service';
import type { ApiCacheService } from './api-cache.service';
import type { ApiKeysService } from '../api-keys/api-keys.service';

const file = (id: number) => ({
  id,
  displayName: `f${id}`,
  fileName: `f${id}.jar`,
  fileDate: '2026-01-01T00:00:00Z',
  fileLength: 1,
  gameVersions: ['1.21.1', 'Fabric'],
});

describe('CurseforgeApiService.getAllFiles', () => {
  const realFetch = global.fetch;
  let indexes: string[];

  beforeEach(() => {
    indexes = [];
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  function service(total: number) {
    global.fetch = (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const index = Number(url.searchParams.get('index'));
      indexes.push(url.searchParams.get('index')!);
      const count = Math.max(0, Math.min(50, total - index));
      return Promise.resolve(
        Response.json({
          data: Array.from({ length: count }, (_, i) => file(index + i)),
          pagination: { totalCount: total },
        }),
      );
    };
    const cache = {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
    } as unknown as ApiCacheService;
    const keys = {
      getKey: () => Promise.resolve('k'),
    } as unknown as ApiKeysService;
    return new CurseforgeApiService(cache, keys);
  }

  it('follows pagination until totalCount is reached', async () => {
    const files = await service(120).getAllFiles(1);
    expect(files).toHaveLength(120);
    expect(indexes).toEqual(['0', '50', '100']);
  });

  it('stops after maxPages', async () => {
    const files = await service(500).getAllFiles(1, { maxPages: 2 });
    expect(files).toHaveLength(100);
    expect(indexes).toEqual(['0', '50']);
  });
});
