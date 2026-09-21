import { Test } from '@nestjs/testing';
import { DbService } from '../db/db.service';
import { EventsService } from '../events/events.service';
import { PackPinGuardService } from '../servers/pack-pin-guard.service';
import { ServerQueryService } from '../servers/server-query.service';
import type { Server } from '../servers/types';
import { PackPinSweepService } from './pack-pin-sweep.service';

interface RecordedEvent {
  serverId?: string;
  type: string;
  summary?: string;
}

interface FakeServerPackRow {
  platform: string;
  projectRef: string;
  pinnedVersionId: string;
}

/** Minimal `Server` stand-in — only the fields the sweep actually reads. */
function fakeServer(
  id: string,
  type: string,
  env: Record<string, string>,
): Server {
  return { id, type, env } as unknown as Server;
}

describe('PackPinSweepService', () => {
  let servers: Server[];
  let packRowsById: Map<string, FakeServerPackRow | undefined>;
  let updatesById: Map<string, Record<string, unknown>>;
  let recorded: RecordedEvent[];
  let service: PackPinSweepService;

  beforeEach(async () => {
    servers = [];
    packRowsById = new Map();
    updatesById = new Map();
    recorded = [];

    // select().from(serverPacks).where(eq(serverPacks.serverId, id)).limit(1)
    // — the mock can't introspect the drizzle `eq()` condition, so it walks
    // `servers` (in query order) to find whichever id hasn't been resolved
    // yet, matching the sweep's strictly-sequential per-server for-of loop.
    let queryCursor = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => {
              const id = servers[queryCursor]?.id;
              queryCursor += 1;
              const row = id ? packRowsById.get(id) : undefined;
              return Promise.resolve(row ? [row] : []);
            },
          }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            // Attribute the update to whichever server the sweep is
            // currently on — same sequential assumption as above, but keyed
            // off queryCursor for issue-bearing servers (query always
            // precedes its own update) and current loop position otherwise.
            const id = servers[Math.max(queryCursor - 1, 0)]?.id;
            if (id) updatesById.set(id, values);
            return Promise.resolve();
          },
        }),
      }),
    } as unknown as DbService['db'];

    const moduleRef = await Test.createTestingModule({
      providers: [
        PackPinSweepService,
        PackPinGuardService,
        { provide: DbService, useValue: { db } },
        {
          provide: EventsService,
          useValue: {
            recordEvent: (e: RecordedEvent) => {
              recorded.push(e);
            },
          },
        },
        {
          provide: ServerQueryService,
          useValue: { listServers: () => Promise.resolve(servers) },
        },
      ],
    }).compile();
    service = moduleRef.get(PackPinSweepService);
  });

  it('pins an unpinned CurseForge server from its server_packs record', async () => {
    servers = [
      fakeServer('srv_cf', 'AUTO_CURSEFORGE', { CF_SLUG: 'stoneblock-4' }),
    ];
    packRowsById.set('srv_cf', {
      platform: 'curseforge',
      projectRef: 'stoneblock-4',
      pinnedVersionId: '5891234',
    });

    const result = await service.sweep();

    expect(result).toEqual({ pinned: 1, flagged: 0 });
    expect(updatesById.get('srv_cf')).toMatchObject({
      pendingRecreate: true,
      packPinNeedsReview: false,
    });
    const env = JSON.parse(
      String(updatesById.get('srv_cf')!.envJson),
    ) as Record<string, string>;
    expect(env.CF_FILE_ID).toBe('5891234');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      serverId: 'srv_cf',
      type: 'pack-pinned',
    });
  });

  it('pins an unpinned Modrinth server from its server_packs record', async () => {
    servers = [
      fakeServer('srv_mr', 'MODRINTH', { MODRINTH_MODPACK: 'cobblemon' }),
    ];
    packRowsById.set('srv_mr', {
      platform: 'modrinth',
      projectRef: 'cobblemon',
      pinnedVersionId: 'VeR51On1',
    });

    await service.sweep();

    const env = JSON.parse(
      String(updatesById.get('srv_mr')!.envJson),
    ) as Record<string, string>;
    expect(env.MODRINTH_VERSION).toBe('VeR51On1');
  });

  it('never re-resolves "latest": with no server_packs row it flags for manual review instead of guessing', async () => {
    servers = [
      fakeServer('srv_none', 'AUTO_CURSEFORGE', { CF_SLUG: 'all-the-mods-10' }),
    ];
    // No packRowsById entry at all — no evidence.

    const result = await service.sweep();

    expect(result).toEqual({ pinned: 0, flagged: 1 });
    expect(updatesById.get('srv_none')).toEqual({ packPinNeedsReview: true });
  });

  it('does not trust a server_packs row for a different pack (cross-checked by slug)', async () => {
    servers = [
      fakeServer('srv_wrong', 'AUTO_CURSEFORGE', {
        CF_SLUG: 'all-the-mods-10',
      }),
    ];
    // A stale record from a pack the selector no longer names.
    packRowsById.set('srv_wrong', {
      platform: 'curseforge',
      projectRef: 'some-other-pack',
      pinnedVersionId: '99',
    });

    const result = await service.sweep();

    expect(result).toEqual({ pinned: 0, flagged: 1 });
    expect(updatesById.get('srv_wrong')).toEqual({ packPinNeedsReview: true });
  });

  it('does not trust a server_packs row for a different platform', async () => {
    servers = [
      fakeServer('srv_platform', 'MODRINTH', { MODRINTH_MODPACK: 'cobblemon' }),
    ];
    packRowsById.set('srv_platform', {
      platform: 'curseforge',
      projectRef: 'cobblemon',
      pinnedVersionId: '5891234',
    });

    const result = await service.sweep();

    expect(result).toEqual({ pinned: 0, flagged: 1 });
  });

  it('leaves already-pinned and non-pack servers alone', async () => {
    servers = [
      fakeServer('srv_pinned', 'AUTO_CURSEFORGE', {
        CF_SLUG: 'atm10',
        CF_FILE_ID: '1',
      }),
      fakeServer('srv_vanilla', 'PAPER', { MEMORY: '4G' }),
    ];

    const result = await service.sweep();

    expect(result).toEqual({ pinned: 0, flagged: 0 });
    expect(updatesById.size).toBe(0);
    expect(recorded).toEqual([]);
  });

  it('is idempotent: a server already flagged with no new evidence stays flagged, not double-counted oddly', async () => {
    servers = [
      fakeServer('srv_none', 'AUTO_CURSEFORGE', { CF_SLUG: 'all-the-mods-10' }),
    ];

    const first = await service.sweep();
    updatesById.clear();
    const second = await service.sweep();

    expect(first).toEqual({ pinned: 0, flagged: 1 });
    expect(second).toEqual({ pinned: 0, flagged: 1 });
  });
});
