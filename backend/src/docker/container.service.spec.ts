import { EventEmitter } from 'node:events';
import { ContainerService } from './container.service';
import { DbService } from '../db/db.service';
import { DockerConnectionService } from './docker-connection.service';
import { HostPathService } from './host-path.service';

const SERVER_ID = 'srv_exec';

/** Minimal stand-in for a dockerode hijacked exec stream. */
class FakeStream extends EventEmitter {
  destroy = jest.fn();
}

interface FakeExecOptions {
  abortSignal?: AbortSignal;
}

/**
 * Drives the create/start/inspect sequence dockerode's `Exec` exposes, with
 * each phase controllable independently: resolve normally, hang forever, or
 * reject when its abortSignal fires (mirroring dockerode/docker-modem's real
 * abort behavior for an in-flight request).
 */
function makeFakeExec(opts: {
  hangOn?: 'create' | 'start';
  stream?: FakeStream;
  inspectResult?: { ExitCode: number | null };
}) {
  const abortable = (
    phase: 'create' | 'start',
    resolveWith: unknown,
  ): ((execOpts?: FakeExecOptions) => Promise<unknown>) => {
    return (execOpts) =>
      new Promise((resolve, reject) => {
        if (opts.hangOn === phase) {
          execOpts?.abortSignal?.addEventListener('abort', () =>
            reject(new Error(`${phase} aborted`)),
          );
          return; // never resolves otherwise — simulates a stalled daemon
        }
        resolve(resolveWith);
      });
  };

  const stream = opts.stream ?? new FakeStream();
  const fakeExecHandle = {
    start: abortable('start', stream),
    inspect: jest.fn().mockResolvedValue(opts.inspectResult ?? { ExitCode: 0 }),
  };

  return {
    exec: abortable('create', fakeExecHandle) as unknown as () => Promise<
      typeof fakeExecHandle
    >,
    stream,
  };
}

function makeService(fakeContainer: {
  exec: (opts?: FakeExecOptions) => Promise<unknown>;
}): ContainerService {
  const dbService = {
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
    },
  } as unknown as DbService;

  const connection = {
    getDocker: () => ({
      getContainer: () => fakeContainer,
      modem: {
        // Mirrors demuxStream's job closely enough for tests: pass raw
        // 'data' events straight through instead of parsing the 8-byte
        // frame headers, since these tests never send real frames.
        demuxStream: (
          stream: EventEmitter,
          out: { write: (b: Buffer) => void },
        ) => {
          stream.on('data', (b: Buffer) => out.write(b));
        },
      },
    }),
  } as unknown as DockerConnectionService;

  const hostPath = {} as HostPathService;

  return new ContainerService(connection, hostPath, dbService);
}

describe('ContainerService.execRaw — one deadline for create+start+stream', () => {
  it('resolves normally when create/start/stream all complete in time', async () => {
    const stream = new FakeStream();
    const { exec } = makeFakeExec({ stream });
    const service = makeService({ exec });

    const promise = service.execRaw(SERVER_ID, ['echo', 'hi'], {
      timeoutMs: 200,
    });
    // Let create/start settle, then emit output on the stream.
    await new Promise((r) => setTimeout(r, 10));
    stream.emit('data', Buffer.from('hi\n'));
    stream.emit('end');

    await expect(promise).resolves.toEqual({ stdout: 'hi\n', exitCode: null });
  });

  it('times out a stalled `exec create` instead of hanging forever', async () => {
    const { exec } = makeFakeExec({ hangOn: 'create' });
    const service = makeService({ exec });

    await expect(
      service.execRaw(SERVER_ID, ['sleep', '999'], { timeoutMs: 30 }),
    ).rejects.toThrow(/exec timed out after 30ms/);
  });

  it('times out a stalled `exec start` instead of hanging forever', async () => {
    const { exec } = makeFakeExec({ hangOn: 'start' });
    const service = makeService({ exec });

    await expect(
      service.execRaw(SERVER_ID, ['sleep', '999'], { timeoutMs: 30 }),
    ).rejects.toThrow(/exec timed out after 30ms/);
  });

  it('times out a stream that never ends, and destroys it', async () => {
    const stream = new FakeStream();
    const { exec } = makeFakeExec({ stream });
    const service = makeService({ exec });

    await expect(
      service.execRaw(SERVER_ID, ['tail', '-f'], { timeoutMs: 30 }),
    ).rejects.toThrow(/exec timed out after 30ms/);
    expect(stream.destroy).toHaveBeenCalled();
  });

  it('shares the single deadline with the optional exit-code inspect call', async () => {
    const stream = new FakeStream();
    const { exec } = makeFakeExec({
      stream,
      inspectResult: { ExitCode: 7 },
    });
    const service = makeService({ exec });

    const promise = service.execRaw(SERVER_ID, ['false'], {
      timeoutMs: 200,
      wantExitCode: true,
    });
    await new Promise((r) => setTimeout(r, 10));
    stream.emit('end');

    await expect(promise).resolves.toEqual({ stdout: '', exitCode: 7 });
  });
});
