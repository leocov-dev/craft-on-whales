import { Test } from '@nestjs/testing';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { SecretsService } from '../auth/secrets.service';
import { ConfigService } from '../config/config.service';
import { DbService } from '../db/db.service';
import { ContainerService } from '../docker/container.service';
import { DockerImagesService } from '../docker/docker-images.service';
import { DockerLogsService } from '../docker/docker-logs.service';
import { DockerWatcherService } from '../docker/docker-watcher.service';
import { EventsService } from '../events/events.service';
import { McRouterService } from '../mc-router/mc-router.service';
import { SettingsService } from '../settings/settings.service';
import { StatusBusService } from '../status-bus/status-bus.service';
import { PathGuardService } from '../storage/path-guard.service';
import { DockerSpecService } from './docker-spec.service';
import { PackPinGuardService } from './pack-pin-guard.service';
import { PortsService } from './ports.service';
import { SCHEDULER_CONTRACT } from './scheduler.contract';
import { ServerEnvironmentService } from './server-environment.service';
import { ServerLifecycleService } from './server-lifecycle.service';
import { ServerLocksService } from './server-locks.service';
import { ServerQueryService } from './server-query.service';

describe('ServerLifecycleService routing changes', () => {
  let service: ServerLifecycleService;
  let routedIds: string[];
  let statusById: Record<string, string>;
  let flagged: string[];
  let recreate: jest.Mock;

  beforeEach(async () => {
    routedIds = ['stopped1', 'running1', 'stopped2'];
    statusById = {
      stopped1: 'stopped',
      running1: 'running',
      stopped2: 'stopped',
    };
    flagged = [];
    recreate = jest.fn().mockResolvedValue(undefined);

    // The `where` arg is opaque, so flagged servers are tracked by call order
    // (refreshRoutedServers walks them in `routedIds` order).
    let updateIndex = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve(routedIds.map((id) => ({ id }))),
        }),
      }),
      update: () => ({
        set: (values: { pendingRecreate?: boolean }) => ({
          where: () => {
            if (values.pendingRecreate)
              flagged.push(routedIds[updateIndex++] ?? '');
            return Promise.resolve();
          },
        }),
      }),
    } as unknown as DbService['db'];

    const noop = {};
    const moduleRef = await Test.createTestingModule({
      providers: [
        ServerLifecycleService,
        { provide: DbService, useValue: { db } },
        { provide: EventsService, useValue: { recordEvent: () => undefined } },
        { provide: SecretsService, useValue: noop },
        { provide: ConfigService, useValue: noop },
        { provide: SettingsService, useValue: noop },
        { provide: PathGuardService, useValue: noop },
        { provide: ApiKeysService, useValue: noop },
        { provide: PortsService, useValue: noop },
        { provide: DockerSpecService, useValue: noop },
        {
          provide: ContainerService,
          useValue: {
            inspectStatus: (id: string) =>
              Promise.resolve({
                exists: true,
                status: statusById[id],
                health: null,
              }),
          },
        },
        { provide: DockerImagesService, useValue: noop },
        { provide: DockerLogsService, useValue: noop },
        {
          provide: DockerWatcherService,
          useValue: { setAutoRestartHandler: () => undefined },
        },
        { provide: ServerQueryService, useValue: noop },
        { provide: ServerEnvironmentService, useValue: noop },
        {
          provide: ServerLocksService,
          useValue: {
            guard: (_id: string, _op: string, fn: () => Promise<unknown>) =>
              fn(),
          },
        },
        { provide: McRouterService, useValue: noop },
        PackPinGuardService,
        StatusBusService,
        { provide: SCHEDULER_CONTRACT, useValue: noop },
      ],
    }).compile();
    service = moduleRef.get(ServerLifecycleService);
    (
      service as unknown as { recreateServerImpl: jest.Mock }
    ).recreateServerImpl = recreate;
  });

  it('recreates a server with no live container right away', async () => {
    await expect(service.applyRoutingChange('stopped1')).resolves.toBe(true);
    expect(recreate).toHaveBeenCalledTimes(1);
  });

  it('leaves a live server flagged for its next restart', async () => {
    await expect(service.applyRoutingChange('running1')).resolves.toBe(false);
    expect(recreate).not.toHaveBeenCalled();
  });

  it('refreshRoutedServers flags every routed server and recreates only the idle ones', async () => {
    const result = await service.refreshRoutedServers();

    expect(flagged).toEqual(routedIds);
    expect(result).toEqual({ recreated: 2, pending: 1 });
    expect(recreate).toHaveBeenCalledTimes(2);
  });

  it('keeps going and counts a failed recreate as pending', async () => {
    recreate.mockRejectedValueOnce(new Error('name in use'));

    const result = await service.refreshRoutedServers();

    expect(result).toEqual({ recreated: 1, pending: 2 });
  });
});
