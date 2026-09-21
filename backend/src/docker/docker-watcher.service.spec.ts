import { Test } from '@nestjs/testing';
import { DbService } from '../db/db.service';
import { servers } from '../db/schema';
import { EventsService } from '../events/events.service';
import { ContainerService, LABEL } from './container.service';
import { DockerConnectionService } from './docker-connection.service';
import { DockerLogsService } from './docker-logs.service';
import {
  DockerWatcherService,
  type DockerEvent,
} from './docker-watcher.service';

const SERVER_ID = 'srv_watch';

interface RecordedEvent {
  serverId: string;
  type: string;
  summary?: string;
  details?: Record<string, unknown>;
}

interface DbState {
  server: { id: string; autoRestart: boolean } | null;
  stopRequested: boolean;
  updates: Record<string, unknown>[];
}

/**
 * Minimal stand-in for the two drizzle chains handleEvent() uses:
 * `select().from(t).where().limit(1)` and `update(t).set().where()`.
 * Which SELECT is running is decided by the table passed to `.from()`.
 */
function makeDb(state: DbState): DbService['db'] {
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () =>
            Promise.resolve(
              table === servers
                ? state.server
                  ? [state.server]
                  : []
                : state.stopRequested
                  ? [{ x: 1 }]
                  : [],
            ),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          state.updates.push(values);
          return Promise.resolve();
        },
      }),
    }),
  };
  return db as unknown as DbService['db'];
}

type Shape = 'status' | 'Action' | 'action';

const dieEvent = (exitCode: string, shape: Shape): DockerEvent => {
  const evt: DockerEvent = {
    Actor: { Attributes: { [LABEL]: SERVER_ID, exitCode } },
  };
  if (shape === 'status') evt.status = 'die';
  else if (shape === 'Action') evt.Action = 'die';
  else evt.action = 'die';
  return evt;
};

describe('DockerWatcherService', () => {
  let service: DockerWatcherService;
  let state: DbState;
  let recorded: RecordedEvent[];
  let logTail: string;
  let restarted: string[];
  let inspectStatus: jest.Mock;

  const lastStatus = (): string | undefined => {
    const withStatus = state.updates.filter((u) => 'status' in u);
    return withStatus.length
      ? (withStatus[withStatus.length - 1]!.status as string)
      : undefined;
  };
  const eventsOfType = (type: string): RecordedEvent[] =>
    recorded.filter((e) => e.type === type);

  const build = async (autoRestart: boolean): Promise<void> => {
    state = {
      server: { id: SERVER_ID, autoRestart },
      stopRequested: false,
      updates: [],
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        DockerWatcherService,
        {
          provide: DockerConnectionService,
          useValue: { getDocker: () => ({}) },
        },
        { provide: ContainerService, useValue: { inspectStatus } },
        {
          provide: DockerLogsService,
          useValue: { fetchLogs: () => Promise.resolve(logTail) },
        },
        {
          provide: EventsService,
          useValue: {
            recordEvent: (e: RecordedEvent) => {
              recorded.push(e);
            },
          },
        },
        { provide: DbService, useValue: { db: makeDb(state) } },
      ],
    }).compile();
    service = moduleRef.get(DockerWatcherService);
    service.setAutoRestartHandler((id) => {
      restarted.push(id);
      return Promise.resolve();
    });
  };

  beforeEach(() => {
    recorded = [];
    restarted = [];
    logTail = '';
    inspectStatus = jest
      .fn()
      .mockResolvedValue({ exists: true, status: 'crashed' });
    state = { server: null, stopRequested: false, updates: [] };
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('event shape', () => {
    it.each(['status', 'Action', 'action'] as const)(
      'treats a die reported via `%s` as a crash',
      async (shape) => {
        await build(false);

        await service.handleEvent(dieEvent('1', shape));

        expect(lastStatus()).toBe('crashed');
        expect(eventsOfType('crashed')).toHaveLength(1);
      },
    );

    it.each(['status', 'Action'] as const)(
      'reaches the auto-restart path identically via `%s`',
      async (shape) => {
        jest.useFakeTimers();
        await build(true);

        await service.handleEvent(dieEvent('1', shape));
        expect(restarted).toEqual([]); // not before the backoff elapses

        await jest.advanceTimersByTimeAsync(6000);

        expect(restarted).toEqual([SERVER_ID]);
      },
    );

    it('reads `Action` for start, healthy and oom events too', async () => {
      await build(false);
      const actor = { Attributes: { [LABEL]: SERVER_ID } };

      await service.handleEvent({ Action: 'start', Actor: actor });
      expect(lastStatus()).toBe('starting');

      await service.handleEvent({
        Action: 'health_status: healthy',
        Actor: actor,
      });
      expect(lastStatus()).toBe('running');

      await service.handleEvent({ Action: 'oom', Actor: actor });
      expect(eventsOfType('oom')).toHaveLength(1);
    });

    it('ignores an event kind it does not handle', async () => {
      await build(true);

      await service.handleEvent({
        Action: 'exec_start: ls',
        Actor: { Attributes: { [LABEL]: SERVER_ID } },
      });

      expect(state.updates).toEqual([]);
      expect(recorded).toEqual([]);
    });
  });

  describe('clean exits are never fought with an auto-restart', () => {
    // 0 = in-game /stop, console stop or the image's own auto-stop;
    // 143 = SIGTERM (docker stop / host shutdown); 130 = SIGINT.
    it.each(['0', '143', '130'])(
      'an unrequested exit %s is a stop, not a crash',
      async (exitCode) => {
        jest.useFakeTimers();
        await build(true);

        await service.handleEvent(dieEvent(exitCode, 'Action'));
        await jest.advanceTimersByTimeAsync(60_000);

        expect(lastStatus()).toBe('stopped');
        expect(eventsOfType('stopped')).toHaveLength(1);
        expect(eventsOfType('crashed')).toEqual([]);
        expect(restarted).toEqual([]);
      },
    );

    it('a requested clean exit records no extra stopped event', async () => {
      await build(true);
      state.stopRequested = true;

      await service.handleEvent(dieEvent('0', 'Action'));

      expect(lastStatus()).toBe('stopped');
      expect(recorded).toEqual([]);
      expect(restarted).toEqual([]);
    });

    it('SIGKILL inside a stop window is intentional, not a crash', async () => {
      jest.useFakeTimers();
      await build(true);
      state.stopRequested = true;

      await service.handleEvent(dieEvent('137', 'Action'));
      await jest.advanceTimersByTimeAsync(60_000);

      expect(lastStatus()).toBe('stopped');
      expect(eventsOfType('crashed')).toEqual([]);
      expect(restarted).toEqual([]);
    });

    it('SIGKILL with no stop request is a crash but is not restarted', async () => {
      jest.useFakeTimers();
      await build(true);

      await service.handleEvent(dieEvent('137', 'Action'));
      await jest.advanceTimersByTimeAsync(60_000);

      expect(lastStatus()).toBe('crashed');
      expect(eventsOfType('crashed')).toHaveLength(1);
      expect(restarted).toEqual([]);
    });

    it('a non-zero exit inside a stop window is still recorded as a crash', async () => {
      jest.useFakeTimers();
      await build(true);
      state.stopRequested = true;

      await service.handleEvent(dieEvent('1', 'Action'));
      await jest.advanceTimersByTimeAsync(60_000);

      expect(lastStatus()).toBe('crashed');
      const [crash] = eventsOfType('crashed');
      expect(crash?.details?.duringStopWindow).toBe(true);
      expect(restarted).toEqual([]);
    });
  });

  describe('crash handling', () => {
    it('skips auto-restart for a diagnosable config error', async () => {
      jest.useFakeTimers();
      logTail = 'You need to agree to the EULA in order to run the server';
      await build(true);

      await service.handleEvent(dieEvent('1', 'Action'));
      await jest.advanceTimersByTimeAsync(60_000);

      const [crash] = eventsOfType('crashed');
      expect(crash?.details?.diagnosis).toBe('eula');
      expect(restarted).toEqual([]);
    });

    it('never restarts a server with auto-restart off', async () => {
      jest.useFakeTimers();
      await build(false);

      await service.handleEvent(dieEvent('1', 'Action'));
      await jest.advanceTimersByTimeAsync(60_000);

      expect(restarted).toEqual([]);
    });

    it('suspends auto-restart after repeated rapid crashes', async () => {
      jest.useFakeTimers();
      await build(true);

      for (let i = 0; i < 4; i++) {
        await service.handleEvent(dieEvent('1', 'Action'));
      }

      expect(eventsOfType('crash-loop')).toHaveLength(1);
    });

    it('does not restart a container that is no longer crashed', async () => {
      jest.useFakeTimers();
      inspectStatus.mockResolvedValue({ exists: true, status: 'running' });
      await build(true);

      await service.handleEvent(dieEvent('1', 'Action'));
      await jest.advanceTimersByTimeAsync(60_000);

      expect(restarted).toEqual([]);
    });
  });

  it('ignores events for containers the panel does not know', async () => {
    await build(true);
    state.server = null;

    await service.handleEvent(dieEvent('1', 'Action'));

    expect(state.updates).toEqual([]);
    expect(recorded).toEqual([]);
  });
});
