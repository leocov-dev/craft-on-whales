import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ServerLocksService } from '../servers/server-locks.service';
import { WorldArchiveService } from './world-archive.service';
import { WorldChunksService } from './world-chunks.service';
import { WorldSaveLockService } from './world-save-lock.service';
import { parseHeader } from '../utils/mca-region';
import { buildRegion, chunkPayload } from '../utils/mca-region.test-helpers';
import type { ServerQueryService } from '../servers/server-query.service';
import type { EventsService } from '../events/events.service';
import type { BackupsService } from './backups.service';
import type { WorldPropsService } from './world-props.service';
import type { WorldRuntimeService } from './world-runtime.service';
import type { PathGuardService } from '../storage/path-guard.service';

const slot = (x: number, z: number) => x + z * 32;

describe('WorldChunksService', () => {
  let root: string;
  let running: boolean;
  let service: WorldChunksService;
  let recordEvent: jest.Mock;
  let createBackup: jest.Mock;
  const serverDir = () => path.join(root, 'servers', 'srv_a');
  const write = (rel: string, buf: Buffer) => {
    const abs = path.join(serverDir(), rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
  };
  const slotsIn = (rel: string) =>
    parseHeader(fs.readFileSync(path.join(serverDir(), rel))).map(
      (e) => e.index,
    );
  const region = () =>
    buildRegion({
      [slot(0, 0)]: chunkPayload(100),
      [slot(1, 0)]: chunkPayload(5000),
      [slot(31, 31)]: chunkPayload(7),
    });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'chunks-'));
    running = false;
    recordEvent = jest.fn();
    createBackup = jest.fn().mockResolvedValue({});
    write('world/region/r.0.0.mca', region());
    write('world/region/r.-1.-1.mca', region());
    write('world/entities/r.0.0.mca', region());
    write('world/poi/r.0.0.mca', region());
    write('world/DIM-1/region/r.0.0.mca', region());

    const props = {
      serverWorldDims: (_id: string, name: string) => [
        path.join(serverDir(), name),
      ],
    } as unknown as WorldPropsService;
    service = new WorldChunksService(
      {
        mustGet: () => Promise.resolve({ id: 'srv_a', env: {} }),
      } as unknown as ServerQueryService,
      props,
      new WorldArchiveService({} as PathGuardService),
      {
        isRunning: () => Promise.resolve(running),
      } as unknown as WorldRuntimeService,
      new ServerLocksService(),
      new WorldSaveLockService(),
      { createBackup } as unknown as BackupsService,
      { recordEvent } as unknown as EventsService,
    );
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('lists occupied slots per dimension and region', async () => {
    const map = await service.listChunks('srv_a', 'world');
    expect(map.worldName).toBe('world');
    expect(map.spawn.source).toBe('origin');
    const labels = map.dimensions.map((d) => d.label).sort();
    expect(labels).toEqual(['.', 'DIM-1']);
    const overworld = map.dimensions.find((d) => d.label === '.')!;
    expect(overworld.regions).toHaveLength(2);
    expect(
      overworld.regions.find((r) => r.rx === 0 && r.rz === 0)?.slots,
    ).toEqual([slot(0, 0), slot(1, 0), slot(31, 31)]);
    expect(overworld.regions.some((r) => r.rx === -1 && r.rz === -1)).toBe(
      true,
    );
  });

  it('reports InhabitedTime per slot, null where absent', async () => {
    const ticks = await service.regionInhabited('srv_a', 'world', '.', 0, 0);
    expect(ticks).toHaveLength(1024);
    expect(ticks[slot(0, 0)]).toBe(100);
    expect(ticks[slot(1, 0)]).toBe(5000);
    expect(ticks[slot(5, 5)]).toBeNull();
  });

  it('rejects an unknown dimension or region', async () => {
    await expect(
      service.regionInhabited('srv_a', 'world', '../..', 0, 0),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.regionInhabited('srv_a', 'world', '.', 9, 9),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deletes the chosen chunks plus their entities and poi, after a backup', async () => {
    const r = await service.deleteChunks('srv_a', {
      worldName: 'world',
      dimension: '.',
      chunks: [
        { cx: 1, cz: 0 },
        { cx: 31, cz: 31 },
        { cx: 400, cz: 400 }, // no such region: ignored
      ],
      actor: 'tester',
    });

    expect(r).toMatchObject({
      chunksRemoved: 2,
      regionsChanged: 1,
      regionsSkipped: 0,
      backedUp: true,
    });
    expect(createBackup).toHaveBeenCalledTimes(1);
    for (const dir of ['region', 'entities', 'poi'])
      expect(slotsIn(`world/${dir}/r.0.0.mca`)).toEqual([slot(0, 0)]);
    // other regions and dimensions are untouched
    expect(slotsIn('world/region/r.-1.-1.mca')).toHaveLength(3);
    expect(slotsIn('world/DIM-1/region/r.0.0.mca')).toHaveLength(3);
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 'srv_a',
        actor: 'tester',
        type: 'world-chunks-deleted',
      }),
    );
  });

  it('maps negative chunk coordinates to the right region slot', async () => {
    // chunk (-1,-1) lives in region r.-1.-1 at local slot (31, 31)
    const r = await service.deleteChunks('srv_a', {
      worldName: 'world',
      dimension: '.',
      chunks: [{ cx: -1, cz: -1 }],
    });
    expect(r.chunksRemoved).toBe(1);
    expect(slotsIn('world/region/r.-1.-1.mca')).toEqual([
      slot(0, 0),
      slot(1, 0),
    ]);
  });

  it('can skip the backup', async () => {
    const r = await service.deleteChunks('srv_a', {
      worldName: 'world',
      dimension: '.',
      chunks: [{ cx: 0, cz: 0 }],
      backup: false,
    });
    expect(r.backedUp).toBe(false);
    expect(createBackup).not.toHaveBeenCalled();
  });

  it('refuses while the server is running, touching nothing', async () => {
    running = true;
    await expect(
      service.deleteChunks('srv_a', {
        worldName: 'world',
        dimension: '.',
        chunks: [{ cx: 0, cz: 0 }],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(createBackup).not.toHaveBeenCalled();
    expect(slotsIn('world/region/r.0.0.mca')).toHaveLength(3);
  });

  it('validates the selection', async () => {
    await expect(
      service.deleteChunks('srv_a', {
        worldName: 'world',
        dimension: '.',
        chunks: [],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.deleteChunks('srv_a', {
        worldName: 'world',
        dimension: 'nope',
        chunks: [{ cx: 0, cz: 0 }],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('removes a region file entirely when its last chunk goes', async () => {
    write(
      'world/region/r.2.2.mca',
      buildRegion({ [slot(3, 3)]: chunkPayload(1) }),
    );
    await service.deleteChunks('srv_a', {
      worldName: 'world',
      dimension: '.',
      chunks: [{ cx: 64 + 3, cz: 64 + 3 }],
    });
    expect(
      fs.existsSync(path.join(serverDir(), 'world/region/r.2.2.mca')),
    ).toBe(false);
  });
});
