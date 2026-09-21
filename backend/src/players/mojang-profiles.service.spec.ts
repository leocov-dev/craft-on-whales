import { DbService } from '../db/db.service';
import { MojangProfilesService } from './mojang-profiles.service';

interface CacheRow {
  key: string;
  valueJson: string;
  fetchedAt: string;
}

/**
 * Minimal stand-in for the apiCache table's drizzle chain. All of these
 * tests look up a single player name (case-insensitively), so the fake
 * ignores the real `eq(apiCache.key, key)` condition object and just keeps
 * one row slot — good enough to exercise resolveProfile's cache-hit,
 * cache-miss and single-flight-dedup paths without reproducing drizzle.
 */
function makeDb(state: { row: CacheRow | null }): DbService['db'] {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(state.row ? [state.row] : []),
        }),
      }),
    }),
    insert: () => ({
      values: (v: CacheRow) => ({
        onConflictDoUpdate: ({ set }: { set: Partial<CacheRow> }) => {
          state.row = { ...v, ...set };
          return Promise.resolve();
        },
      }),
    }),
  };
  return db as unknown as DbService['db'];
}

function makeService(): {
  service: MojangProfilesService;
  state: { row: CacheRow | null };
} {
  const state = { row: null as CacheRow | null };
  const dbService = { db: makeDb(state) } as unknown as DbService;
  return { service: new MojangProfilesService(dbService), state };
}

describe('MojangProfilesService.resolveProfile — single-flight dedup', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('shares one outbound request across concurrent lookups of the same name', async () => {
    let callCount = 0;
    let resolveFetch!: (body: unknown) => void;
    global.fetch = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          callCount++;
          resolveFetch = (body: unknown) =>
            resolve({
              status: 200,
              ok: true,
              json: () => Promise.resolve(body),
            });
        }),
    );

    const { service } = makeService();

    const p1 = service.resolveProfile('Notch');
    const p2 = service.resolveProfile('Notch');
    const p3 = service.resolveProfile('NOTCH'); // case-insensitive key

    // Let the microtask queue settle enough for all three calls to have
    // reached the fetch() call before it resolves.
    await Promise.resolve();
    await Promise.resolve();

    expect(callCount).toBe(1); // exactly one outbound request, not three

    resolveFetch({
      id: '069a79f444e94726a5befca90e38aaf',
      name: 'Notch',
    });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toEqual(r2);
    expect(r2).toEqual(r3);
    expect(r1?.name).toBe('Notch');
  });

  it('issues a fresh request for the next call after the shared one settles', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        status: 200,
        ok: true,
        json: () =>
          Promise.resolve({
            id: '069a79f444e94726a5befca90e38aaf',
            name: 'Notch',
          }),
      });
    });

    const { service, state } = makeService();

    await service.resolveProfile('Notch');
    expect(callCount).toBe(1);

    // Cache now has a fresh entry, so a second call is served from cache,
    // not the in-flight map or a new request.
    expect(state.row).not.toBeNull();
    await service.resolveProfile('Notch');
    expect(callCount).toBe(1);
  });

  it('clears the in-flight entry even when the shared request fails', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: () =>
          Promise.resolve({
            id: '069a79f444e94726a5befca90e38aaf',
            name: 'Notch',
          }),
      });

    const { service } = makeService();

    await expect(service.resolveProfile('Notch')).rejects.toThrow(
      'network down',
    );
    // A subsequent call must retry (not be permanently stuck on the failed
    // in-flight promise).
    const profile = await service.resolveProfile('Notch');
    expect(profile?.name).toBe('Notch');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
