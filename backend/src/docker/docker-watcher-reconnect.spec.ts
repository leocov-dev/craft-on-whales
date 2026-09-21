import { EventEmitter } from 'node:events';
import { DbService } from '../db/db.service';
import { EventsService } from '../events/events.service';
import { ContainerService } from './container.service';
import { DockerConnectionService } from './docker-connection.service';
import { DockerLogsService } from './docker-logs.service';
import { DockerWatcherService } from './docker-watcher.service';

/** Minimal stand-in for the dockerode events stream. */
class FakeEventStream extends EventEmitter {}

function makeService(getEvents: jest.Mock): DockerWatcherService {
  const dbService = { db: {} } as unknown as DbService;
  const containers = {} as unknown as ContainerService;
  const logs = {} as unknown as DockerLogsService;
  const eventsService = {
    recordEvent: jest.fn(),
  } as unknown as EventsService;
  const connection = {
    getDocker: () => ({ getEvents }),
  } as unknown as DockerConnectionService;
  return new DockerWatcherService(
    connection,
    containers,
    logs,
    eventsService,
    dbService,
  );
}

describe('DockerWatcherService — events buffer cap', () => {
  it('drops an oversized unterminated buffer instead of growing without bound', async () => {
    const stream = new FakeEventStream();
    const getEvents = jest.fn().mockResolvedValue(stream);
    const service = makeService(getEvents);
    const errorSpy = jest
      .spyOn(
        (service as unknown as { logger: { error: (m: string) => void } })
          .logger,
        'error',
      )
      .mockImplementation(() => undefined);

    await service.startWatcher();

    // A giant chunk with no newline — must not be retained/concatenated
    // without bound, and must not throw.
    const huge = Buffer.alloc(300 * 1024, 'a');
    expect(() => stream.emit('data', huge)).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('events line buffer exceeded'),
    );

    // The watcher must still be usable afterwards: a clean, well-formed
    // line arriving next is parsed normally (proves the buffer was reset,
    // not left corrupt).
    const handleEventSpy = jest
      .spyOn(service, 'handleEvent')
      .mockResolvedValue(undefined);
    stream.emit('data', Buffer.from('{"status":"start"}\n'));
    await Promise.resolve();
    expect(handleEventSpy).toHaveBeenCalledWith({ status: 'start' });
  });
});

describe('DockerWatcherService — reconnect backoff', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('doubles the reconnect delay on each consecutive failure, capped', async () => {
    jest.useFakeTimers();
    const stream = new FakeEventStream();
    // First connect succeeds so we can drive disconnects deterministically.
    const getEvents = jest.fn().mockResolvedValue(stream);
    const service = makeService(getEvents);
    jest
      .spyOn(
        (service as unknown as { logger: { error: (m: string) => void } })
          .logger,
        'error',
      )
      .mockImplementation(() => undefined);
    jest
      .spyOn(
        (service as unknown as { logger: { log: (m: string) => void } }).logger,
        'log',
      )
      .mockImplementation(() => undefined);

    await service.startWatcher();
    expect(getEvents).toHaveBeenCalledTimes(1);

    // Make every reconnect attempt itself fail so we can observe the
    // backoff schedule purely through elapsed time vs. call count, without
    // a real stream re-triggering another disconnect each time.
    getEvents.mockRejectedValue(new Error('daemon unreachable'));

    // Disconnect #1 → next attempt scheduled at 5s.
    stream.emit('end');
    await jest.advanceTimersByTimeAsync(4999);
    expect(getEvents).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(getEvents).toHaveBeenCalledTimes(2); // fails again → schedules 10s

    await jest.advanceTimersByTimeAsync(9999);
    expect(getEvents).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(getEvents).toHaveBeenCalledTimes(3); // fails again → schedules 20s

    await jest.advanceTimersByTimeAsync(19999);
    expect(getEvents).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(1);
    expect(getEvents).toHaveBeenCalledTimes(4);
  });

  it('resets the backoff to the base delay after a successful reconnect', async () => {
    jest.useFakeTimers();
    const stream1 = new FakeEventStream();
    const getEvents = jest.fn().mockResolvedValue(stream1);
    const service = makeService(getEvents);
    jest
      .spyOn(
        (service as unknown as { logger: { error: (m: string) => void } })
          .logger,
        'error',
      )
      .mockImplementation(() => undefined);
    jest
      .spyOn(
        (service as unknown as { logger: { log: (m: string) => void } }).logger,
        'log',
      )
      .mockImplementation(() => undefined);

    await service.startWatcher();

    // First failure → 5s backoff, then succeeds with a fresh stream.
    const stream2 = new FakeEventStream();
    getEvents.mockRejectedValueOnce(new Error('blip'));
    stream1.emit('end');
    await jest.advanceTimersByTimeAsync(5000); // attempt #2 fails, schedules 10s
    getEvents.mockResolvedValueOnce(stream2);
    await jest.advanceTimersByTimeAsync(10000); // attempt #3 succeeds
    expect(getEvents).toHaveBeenCalledTimes(3);

    // Disconnect again — backoff should restart at 5s, not continue from 20s.
    getEvents.mockRejectedValue(new Error('blip again'));
    stream2.emit('end');
    await jest.advanceTimersByTimeAsync(4999);
    expect(getEvents).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(1);
    expect(getEvents).toHaveBeenCalledTimes(4);
  });
});
