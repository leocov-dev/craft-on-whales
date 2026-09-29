// Request/response shape of the two reverse-lookup endpoints JarIdentifierService
// relies on: Modrinth's POST /v2/version_files and CurseForge's
// POST /v1/fingerprints/432 (plus their bulk project companions).
import { Test } from '@nestjs/testing';
import { PreconditionFailedException } from '@nestjs/common';
import { ApiCacheService } from './api-cache.service';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { ModrinthApiService } from './modrinth-api.service';
import { CurseforgeApiService } from './curseforge-api.service';

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

const rawVersion = (id: string, projectId: string) => ({
  id,
  project_id: projectId,
  version_number: '1.0.0',
  game_versions: ['1.21.1'],
  loaders: ['fabric'],
  files: [],
});

const rawCfFile = (id: number, fingerprint: number) => ({
  id,
  displayName: `file ${id}`,
  fileName: `file-${id}.jar`,
  downloadUrl: null,
  gameVersions: ['1.21.1', 'NeoForge'],
  releaseType: 1,
  fileDate: '2026-01-01T00:00:00Z',
  fileLength: 10,
  hashes: [{ value: 'ab', algo: 1 }],
  fileFingerprint: fingerprint,
});

describe('hash / fingerprint lookups', () => {
  let modrinth: ModrinthApiService;
  let curseforge: CurseforgeApiService;
  let cache: FakeApiCache;
  let key: string | null;
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  const call = (i: number) => {
    const [input, init] = fetchMock.mock.calls[i]!;
    const url = input instanceof Request ? input.url : input.toString();
    const body: unknown =
      typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    return { url, method: init?.method, body };
  };

  beforeEach(async () => {
    cache = new FakeApiCache();
    key = 'test-key';
    const moduleRef = await Test.createTestingModule({
      providers: [
        ModrinthApiService,
        CurseforgeApiService,
        { provide: ApiCacheService, useValue: cache },
        {
          provide: ApiKeysService,
          useValue: { getKey: () => Promise.resolve(key) },
        },
      ],
    }).compile();
    modrinth = moduleRef.get(ModrinthApiService);
    curseforge = moduleRef.get(CurseforgeApiService);
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => fetchMock.mockRestore());

  describe('ModrinthApiService.getVersionsByHashes', () => {
    it('POSTs the deduplicated, lowercased hashes and keys the answer by hash', async () => {
      fetchMock.mockResolvedValue(
        Response.json({ aaa: rawVersion('v1', 'p1') }),
      );
      const out = await modrinth.getVersionsByHashes(['AAA', 'aaa', 'bbb']);
      expect(call(0)).toEqual({
        url: 'https://api.modrinth.com/v2/version_files',
        method: 'POST',
        body: { hashes: ['aaa', 'bbb'], algorithm: 'sha1' },
      });
      expect([...out.keys()]).toEqual(['aaa']);
      expect(out.get('aaa')).toMatchObject({ id: 'v1', project_id: 'p1' });
      // POST answers aren't cached.
      expect(cache.rows.size).toBe(0);
    });

    it('splits large batches into chunks of 200', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(Response.json({})));
      const hashes = Array.from({ length: 450 }, (_, i) =>
        i.toString(16).padStart(40, '0'),
      );
      await modrinth.getVersionsByHashes(hashes);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const sizes = [0, 1, 2].map(
        (i) => (call(i).body as { hashes: string[] }).hashes.length,
      );
      expect(sizes).toEqual([200, 200, 50]);
    });

    it('makes no request for no hashes', async () => {
      expect((await modrinth.getVersionsByHashes([])).size).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('ModrinthApiService.getProjects', () => {
    it('GETs /projects with a JSON id list and keys by id', async () => {
      fetchMock.mockResolvedValue(
        Response.json([
          { id: 'p1', slug: 'one', title: 'One', project_type: 'mod' },
        ]),
      );
      const out = await modrinth.getProjects(['p1', 'p1']);
      const url = new URL(call(0).url);
      expect(url.pathname).toBe('/v2/projects');
      expect(url.searchParams.get('ids')).toBe('["p1"]');
      expect(out.get('p1')?.title).toBe('One');
    });
  });

  describe('CurseforgeApiService.getFingerprintMatches', () => {
    it('POSTs to /fingerprints/432 and returns exact matches with their fingerprint', async () => {
      fetchMock.mockResolvedValue(
        Response.json({
          data: {
            isCacheBuilt: true,
            exactMatches: [
              {
                id: 238222,
                file: rawCfFile(4242, 3608199863),
                latestFiles: [],
              },
            ],
            exactFingerprints: [3608199863],
            partialMatches: [],
            unmatchedFingerprints: [1],
          },
        }),
      );
      const matches = await curseforge.getFingerprintMatches([
        3608199863, 1, 1,
      ]);
      expect(call(0)).toEqual({
        url: 'https://api.curseforge.com/v1/fingerprints/432',
        method: 'POST',
        body: { fingerprints: [3608199863, 1] },
      });
      const headers = new Headers(fetchMock.mock.calls[0]![1]?.headers);
      expect(headers.get('x-api-key')).toBe('test-key');
      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({
        modId: 238222,
        fingerprint: 3608199863,
        file: {
          fileId: 4242,
          name: 'file 4242',
          gameVersions: ['1.21.1', 'NeoForge'],
        },
      });
    });

    it('treats a null exactMatches as no matches', async () => {
      fetchMock.mockResolvedValue(
        Response.json({ data: { exactMatches: null } }),
      );
      expect(await curseforge.getFingerprintMatches([5])).toEqual([]);
    });

    it('throws PreconditionFailed without calling CurseForge when no key is stored', async () => {
      key = null;
      await expect(
        curseforge.getFingerprintMatches([5]),
      ).rejects.toBeInstanceOf(PreconditionFailedException);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('CurseforgeApiService.getMods', () => {
    it('POSTs the mod ids to /mods and keys the normalized mods by id', async () => {
      fetchMock.mockResolvedValue(
        Response.json({
          data: [
            {
              id: 238222,
              slug: 'jei',
              name: 'Just Enough Items',
              summary: '',
              downloadCount: 1,
              classId: 6,
            },
          ],
        }),
      );
      const mods = await curseforge.getMods([238222, 238222]);
      expect(call(0)).toEqual({
        url: 'https://api.curseforge.com/v1/mods',
        method: 'POST',
        body: { modIds: [238222] },
      });
      expect(mods.get(238222)).toMatchObject({ slug: 'jei', classId: 6 });
    });
  });
});
