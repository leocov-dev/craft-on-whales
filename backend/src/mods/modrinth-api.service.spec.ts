import { ModrinthApiService } from './modrinth-api.service';
import type { ApiCacheService } from './api-cache.service';

const version = (id: string, loaders: string[], mc = ['1.21.1']) => ({
  id,
  version_number: id,
  game_versions: mc,
  loaders,
  files: [],
});

describe('ModrinthApiService loader fallback', () => {
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  let urls: URL[];
  let body: unknown;
  let service: ModrinthApiService;

  beforeEach(() => {
    urls = [];
    body = [];
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation((input) => {
      urls.push(new URL(input instanceof Request ? input.url : input));
      return Promise.resolve(Response.json(body));
    });
    const cache = {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
    } as unknown as ApiCacheService;
    service = new ModrinthApiService(cache);
  });
  afterEach(() => fetchMock.mockRestore());

  it('searches quilt and fabric as one OR-group, and reports game versions', async () => {
    body = {
      hits: [
        {
          project_id: 'p',
          slug: 's',
          title: 'T',
          description: 'd',
          downloads: 1,
          categories: ['fabric'],
          latest_version: 'v',
          versions: ['1.21', '1.21.1'],
        },
      ],
    };
    const hits = await service.search({ query: 'x', loader: 'quilt' });
    const facets = JSON.parse(
      urls[0]!.searchParams.get('facets')!,
    ) as string[][];
    expect(facets).toContainEqual(['categories:quilt', 'categories:fabric']);
    expect(hits[0]!.gameVersions).toEqual(['1.21', '1.21.1']);
  });

  it('keeps a single-loader facet for other loaders', async () => {
    body = { hits: [] };
    await service.search({ query: 'x', loader: 'forge' });
    const facets = JSON.parse(
      urls[0]!.searchParams.get('facets')!,
    ) as string[][];
    expect(facets).toContainEqual(['categories:forge']);
  });

  it('asks for fabric builds on quilt but lists quilt-tagged builds first', async () => {
    // Modrinth answers newest-first: a newer fabric build leads.
    body = [
      version('fabric-new', ['fabric']),
      version('quilt-old', ['quilt']),
      version('fabric-old', ['fabric']),
    ];
    const versions = await service.getVersions('proj', {
      loader: 'quilt',
      mcVersion: '1.21.1',
    });
    expect(urls[0]!.searchParams.get('loaders')).toBe('["quilt","fabric"]');
    expect(urls[0]!.searchParams.get('game_versions')).toBe('["1.21.1"]');
    expect(versions.map((v) => v.id)).toEqual([
      'quilt-old',
      'fabric-new',
      'fabric-old',
    ]);
  });

  it('falls back to the newest fabric build when no quilt build exists', async () => {
    body = [
      version('fabric-new', ['fabric']),
      version('fabric-old', ['fabric']),
    ];
    const versions = await service.getVersions('proj', { loader: 'quilt' });
    expect(versions[0]!.id).toBe('fabric-new');
  });

  it('does not widen a fabric server to quilt builds', async () => {
    await service.getVersions('proj', { loader: 'fabric' });
    expect(urls[0]!.searchParams.get('loaders')).toBe('["fabric"]');
  });
});
