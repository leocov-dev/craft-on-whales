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
import { PathGuardService } from '../storage/path-guard.service';
import { DockerSpecService } from './docker-spec.service';
import { PortsService } from './ports.service';
import { SCHEDULER_CONTRACT } from './scheduler.contract';
import { ServerEnvironmentService } from './server-environment.service';
import {
  ServerLifecycleService,
  STARTUP_STALL_MS,
} from './server-lifecycle.service';
import { ServerLocksService } from './server-locks.service';
import { ServerQueryService } from './server-query.service';
import type { Server } from './types';

const SERVER_ID = 'srv1';

interface RecordedEvent {
  serverId?: string;
  type: string;
  summary?: string;
}

interface InspectResult {
  exists: boolean;
  status: string;
  health: string | null;
}

/** `YYYY-MM-DD HH:MM:SS` UTC — the shape a SQL `datetime('now')` writes. */
const sqlTime = (msAgo: number): string =>
  new Date(Date.now() - msAgo)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, '');

/** Full ISO with `Z` — the shape the panel's own writes leave behind. */
const isoTime = (msAgo: number): string =>
  new Date(Date.now() - msAgo).toISOString();

describe('ServerLifecycleService.refreshStatuses (startup watchdog)', () => {
  let service: ServerLifecycleService;
  let row: { status: string; last_started_at: string | null };
  let inspect: InspectResult;
  let logTail: string;
  let fetchLogs: jest.Mock;
  let recorded: RecordedEvent[];

  beforeEach(async () => {
    row = { status: 'starting', last_started_at: sqlTime(0) };
    inspect = { exists: true, status: 'running', health: null };
    logTail = 'boring boot line with no completion marker\n';
    recorded = [];
    fetchLogs = jest.fn().mockImplementation(() => Promise.resolve(logTail));

    const db = {
      update: () => ({
        set: (values: { status?: string }) => ({
          where: () => {
            if (values.status) row.status = values.status;
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
        {
          provide: EventsService,
          useValue: {
            recordEvent: (e: RecordedEvent) => {
              recorded.push(e);
            },
          },
        },
        { provide: SecretsService, useValue: noop },
        { provide: ConfigService, useValue: noop },
        { provide: PathGuardService, useValue: noop },
        { provide: ApiKeysService, useValue: noop },
        { provide: PortsService, useValue: noop },
        { provide: DockerSpecService, useValue: noop },
        {
          provide: ContainerService,
          useValue: { inspectStatus: () => Promise.resolve(inspect) },
        },
        { provide: DockerImagesService, useValue: noop },
        { provide: DockerLogsService, useValue: { fetchLogs } },
        {
          provide: DockerWatcherService,
          useValue: { setAutoRestartHandler: () => undefined },
        },
        {
          provide: ServerQueryService,
          useValue: {
            listServers: () =>
              Promise.resolve([{ id: SERVER_ID, ...row } as unknown as Server]),
          },
        },
        { provide: ServerEnvironmentService, useValue: noop },
        { provide: ServerLocksService, useValue: noop },
        { provide: SCHEDULER_CONTRACT, useValue: noop },
      ],
    }).compile();
    service = moduleRef.get(ServerLifecycleService);
  });

  const stalledEvents = (): RecordedEvent[] =>
    recorded.filter((e) => e.type === 'startup-stalled');

  it('flags a healthcheck-less server stalled once the deadline passes', async () => {
    row.last_started_at = sqlTime(STARTUP_STALL_MS + 60_000);

    await service.refreshStatuses();

    expect(row.status).toBe('stalled');
    expect(fetchLogs).toHaveBeenCalledTimes(1);
    expect(stalledEvents()).toHaveLength(1);
  });

  it('reads the panel’s own ISO timestamps too, not just SQL ones', async () => {
    row.last_started_at = isoTime(STARTUP_STALL_MS + 60_000);

    await service.refreshStatuses();

    expect(row.status).toBe('stalled');
  });

  it('does not re-fire the stalled event on later polls', async () => {
    row.last_started_at = sqlTime(STARTUP_STALL_MS + 60_000);

    await service.refreshStatuses();
    await service.refreshStatuses();
    await service.refreshStatuses();

    expect(row.status).toBe('stalled');
    expect(stalledEvents()).toHaveLength(1);
  });

  it('recovers a stalled server to running once the boot completes', async () => {
    row.last_started_at = sqlTime(STARTUP_STALL_MS + 60_000);

    await service.refreshStatuses();
    expect(row.status).toBe('stalled');

    logTail = 'Done (12.345s)! For help, type "help"\n';
    await service.refreshStatuses();

    expect(row.status).toBe('running');
  });

  it('leaves a server inside the deadline alone, with no log fetch', async () => {
    row.last_started_at = sqlTime(60_000);

    await service.refreshStatuses();

    expect(row.status).toBe('starting');
    expect(fetchLogs).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });

  it('keeps a slow-but-progressing boot in starting until the deadline', async () => {
    row.last_started_at = sqlTime(5 * 60_000);

    await service.refreshStatuses();

    expect(row.status).toBe('starting');
    expect(fetchLogs).toHaveBeenCalledTimes(1);
    expect(recorded).toEqual([]);
  });

  it('stalls a healthchecked container that never goes healthy, without a log fetch', async () => {
    inspect = { exists: true, status: 'starting', health: 'starting' };
    row.last_started_at = sqlTime(STARTUP_STALL_MS + 60_000);

    await service.refreshStatuses();

    expect(row.status).toBe('stalled');
    expect(fetchLogs).not.toHaveBeenCalled();
    expect(stalledEvents()).toHaveLength(1);
  });

  it('never stalls a container whose start time is unknown', async () => {
    row.last_started_at = null;

    await service.refreshStatuses();

    expect(row.status).toBe('starting');
    expect(fetchLogs).toHaveBeenCalledTimes(1); // probe still runs
    expect(recorded).toEqual([]);
  });

  it('does not touch a server that already left the boot window', async () => {
    row.status = 'running';
    row.last_started_at = sqlTime(STARTUP_STALL_MS + 60_000);

    await service.refreshStatuses();

    expect(row.status).toBe('running');
    expect(fetchLogs).not.toHaveBeenCalled();
  });

  it('marks a starting server stopped when its container is gone', async () => {
    inspect = { exists: false, status: 'stopped', health: null };
    row.last_started_at = sqlTime(STARTUP_STALL_MS + 60_000);

    await service.refreshStatuses();

    expect(row.status).toBe('stopped');
    expect(recorded).toEqual([]);
  });
});
