import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { ConflictException, NotFoundException } from '@nestjs/common';
import * as nbt from 'prismarine-nbt';
import { ServerLocksService } from '../servers/server-locks.service';
import { WorldArchiveService } from './world-archive.service';
import { WorldSaveLockService } from './world-save-lock.service';
import { WorldShrinkService } from './world-shrink.service';
import { parseHeader } from '../utils/mca-region';
import { buildRegion, chunkPayload } from '../utils/mca-region.test-helpers';
import type { ServerQueryService } from '../servers/server-query.service';
import type { EventsService } from '../events/events.service';
import type { WorldPropsService } from './world-props.service';
import type { WorldRuntimeService } from './world-runtime.service';
import type { PathGuardService } from '../storage/path-guard.service';

const slot = (x: number, z: number) => x + z * 32;
const SPAWN_SLOT = slot(0, 0); // inside spawn protection (spawn is 0,0)
const FAR_LOW = slot(20, 20); // far from spawn, barely visited -> dropped
const FAR_HIGH = slot(21, 20); // far from spawn, well visited -> kept
const FAR_UNREADABLE = slot(22, 20); // LZ4 -> kept and counted

function farRegion(): Buffer {
  const lz4 = Buffer.from(chunkPayload(1));
  lz4.writeUInt8(4, 4);
  return buildRegion({
    [SPAWN_SLOT]: chunkPayload(1),
    [FAR_LOW]: chunkPayload(10),
    [FAR_HIGH]: chunkPayload(9000),
    [FAR_UNREADABLE]: lz4,
  });
}

function levelDat(spawn: 'legacy' | 'modern', x: number, z: number): Buffer {
  const data =
    spawn === 'legacy'
      ? {
          SpawnX: { type: 'int' as const, value: x },
          SpawnY: { type: 'int' as const, value: 64 },
          SpawnZ: { type: 'int' as const, value: z },
        }
      : {
          spawn: {
            type: 'compound' as const,
            value: {
              pos: { type: 'intArray' as const, value: [x, 64, z] },
            },
          },
        };
  return zlib.gzipSync(
    nbt.writeUncompressed({
      type: 'compound',
      name: '',
      value: { Data: { type: 'compound', value: data } },
    }),
  );
}

describe('WorldShrinkService', () => {
  let root: string;
  let running: boolean;
  let service: WorldShrinkService;
  let recordEvent: jest.Mock;
  const serverDir = () => path.join(root, 'servers', 'srv_a');
  const world = () => path.join(serverDir(), 'world');
  const write = (rel: string, buf: Buffer) => {
    const abs = path.join(serverDir(), rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
  };
  const slotsIn = (rel: string) =>
    parseHeader(fs.readFileSync(path.join(serverDir(), rel))).map(
      (e) => e.index,
    );

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'shrink-'));
    running = false;
    recordEvent = jest.fn();
    write('world/level.dat', levelDat('legacy', 0, 0));
    write('world/region/r.0.0.mca', farRegion());
    write('world/entities/r.0.0.mca', farRegion());
    write('world/poi/r.0.0.mca', farRegion());
    write('world/DIM-1/region/r.0.0.mca', farRegion());
    write('world_the_end/DIM1/region/r.0.0.mca', farRegion());

    const archive = new WorldArchiveService({} as PathGuardService);
    const props = {
      activeLevelName: () => 'world',
      serverWorldDims: (_id: string, name: string) =>
        [name, `${name}_nether`, `${name}_the_end`]
          .map((n) => path.join(serverDir(), n))
          .filter((p, i) => i === 0 || fs.existsSync(p)),
    } as unknown as WorldPropsService;
    service = new WorldShrinkService(
      {
        mustGet: () => Promise.resolve({ id: 'srv_a', env: {} }),
      } as unknown as ServerQueryService,
      props,
      archive,
      {
        isRunning: () => Promise.resolve(running),
      } as unknown as WorldRuntimeService,
      new ServerLocksService(),
      new WorldSaveLockService(),
      { recordEvent } as unknown as EventsService,
    );
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('drops barely-visited far chunks in every dimension, with their entities and poi', async () => {
    const r = await service.shrinkWorld('srv_a', { actor: 'tester' });

    expect(r.dimensions.sort()).toEqual(['.', 'DIM-1', 'world_the_end/DIM1']);
    expect(r).toMatchObject({
      worldName: 'world',
      dryRun: false,
      regionsScanned: 3,
      regionsSkipped: 0,
      chunksScanned: 12,
      // overworld: FAR_LOW. Nether and End have no spawn protection, so their
      // SPAWN_SLOT chunk (1 tick) goes too.
      chunksRemoved: 5,
      chunksUnreadable: 3, // the LZ4 chunk in each of the three files
      spawn: { cx: 0, cz: 0, source: 'level.dat' },
    });
    expect(r.bytesFreed).toBeGreaterThan(0);

    // Overworld: spawn chunk kept by protection, unreadable chunk kept.
    expect(slotsIn('world/region/r.0.0.mca')).toEqual([
      SPAWN_SLOT,
      FAR_HIGH,
      FAR_UNREADABLE,
    ]);
    expect(slotsIn('world/DIM-1/region/r.0.0.mca')).toEqual([
      FAR_HIGH,
      FAR_UNREADABLE,
    ]);
    expect(slotsIn('world_the_end/DIM1/region/r.0.0.mca')).toEqual([
      FAR_HIGH,
      FAR_UNREADABLE,
    ]);
    // The dropped overworld slot is gone from entities/ and poi/ too.
    expect(slotsIn('world/entities/r.0.0.mca')).toEqual([
      SPAWN_SLOT,
      FAR_HIGH,
      FAR_UNREADABLE,
    ]);
    expect(slotsIn('world/poi/r.0.0.mca')).toEqual([
      SPAWN_SLOT,
      FAR_HIGH,
      FAR_UNREADABLE,
    ]);
    expect(fs.readdirSync(path.join(world(), 'region'))).toEqual(['r.0.0.mca']); // no leftover .tmp
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 'srv_a',
        actor: 'tester',
        type: 'world-shrunk',
      }),
    );
  });

  it('a dry run reports the same numbers, changes nothing, and works on a running server', async () => {
    running = true;
    const before = fs.readFileSync(path.join(world(), 'region', 'r.0.0.mca'));
    const r = await service.shrinkWorld('srv_a', { dryRun: true });
    expect(r).toMatchObject({ dryRun: true, chunksRemoved: 5 });
    expect(r.bytesFreed).toBeGreaterThan(0);
    expect(
      fs.readFileSync(path.join(world(), 'region', 'r.0.0.mca')).equals(before),
    ).toBe(true);
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('refuses a real run on a running server and leaves files alone', async () => {
    running = true;
    const before = fs.readFileSync(path.join(world(), 'region', 'r.0.0.mca'));
    await expect(service.shrinkWorld('srv_a')).rejects.toThrow(
      ConflictException,
    );
    expect(
      fs.readFileSync(path.join(world(), 'region', 'r.0.0.mca')).equals(before),
    ).toBe(true);
  });

  it('refuses while another lifecycle operation is in flight', async () => {
    const locks = new ServerLocksService();
    (service as unknown as { locks: ServerLocksService }).locks = locks;
    let release!: () => void;
    const start = locks.guard(
      'srv_a',
      'start',
      () => new Promise<void>((r) => (release = r)),
    );
    await expect(service.shrinkWorld('srv_a')).rejects.toThrow(
      /already in progress/,
    );
    release();
    await start;
  });

  it('reads spawn from level.dat in both layouts and honours spawnKeepChunks', async () => {
    // Modern layout, spawn moved next to the FAR_LOW chunk (20,20 -> block 320).
    write('world/level.dat', levelDat('modern', 320, 320));
    const near = await service.shrinkWorld('srv_a', {
      dryRun: true,
      spawnKeepChunks: 2,
    });
    expect(near.spawn).toEqual({ cx: 20, cz: 20, source: 'level.dat' });
    // FAR_LOW is now protected; SPAWN_SLOT (0,0) is not, but it only matters
    // in the overworld where it is now dropped instead.
    expect(near.chunksRemoved).toBe(5);

    write('world/level.dat', Buffer.from('not nbt'));
    const fallback = await service.shrinkWorld('srv_a', { dryRun: true });
    expect(fallback.spawn).toEqual({ cx: 0, cz: 0, source: 'origin' });
  });

  it('spawnKeepChunks: 0 disables protection', async () => {
    const r = await service.shrinkWorld('srv_a', {
      dryRun: true,
      spawnKeepChunks: 0,
    });
    expect(r.chunksRemoved).toBe(6);
  });

  it('keeps chunks at or above the threshold', async () => {
    const r = await service.shrinkWorld('srv_a', {
      dryRun: true,
      minInhabitedTicks: 5,
      spawnKeepChunks: 0,
    });
    // 1-tick chunks still go; the 10-tick FAR_LOW chunks are now kept.
    expect(r.chunksRemoved).toBe(3);
  });

  it('removes a region file entirely when every chunk goes', async () => {
    write(
      'world/region/r.1.0.mca',
      buildRegion({ [slot(10, 10)]: chunkPayload(3) }),
    );
    await service.shrinkWorld('srv_a');
    expect(fs.existsSync(path.join(world(), 'region', 'r.1.0.mca'))).toBe(
      false,
    );
  });

  it('leaves a truncated region file untouched and reports it as skipped', async () => {
    const full = farRegion();
    const cut = full.subarray(0, full.length - 4096); // chops the unreadable (last) slot
    write('world/region/r.2.0.mca', cut);
    const r = await service.shrinkWorld('srv_a');
    expect(r.regionsSkipped).toBe(1);
    expect(
      fs.readFileSync(path.join(world(), 'region', 'r.2.0.mca')).equals(cut),
    ).toBe(true);
  });

  it('never follows a symlinked dimension folder out of the world', async () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(outside, 'region'), { recursive: true });
    const victim = path.join(outside, 'region', 'r.0.0.mca');
    fs.writeFileSync(victim, farRegion());
    fs.symlinkSync(outside, path.join(world(), 'DIM1'));
    const before = fs.readFileSync(victim);

    const r = await service.shrinkWorld('srv_a');
    expect(r.dimensions).not.toContain('DIM1');
    expect(fs.readFileSync(victim).equals(before)).toBe(true);
  });

  it('404s for a world that does not exist, and rejects traversal names', async () => {
    await expect(
      service.shrinkWorld('srv_a', { worldName: 'nope', dryRun: true }),
    ).rejects.toThrow(NotFoundException);
    await expect(
      service.shrinkWorld('srv_a', { worldName: '../world', dryRun: true }),
    ).rejects.toThrow();
  });
});
