import { ConflictException } from '@nestjs/common';
import { StatusBusService } from '../status-bus/status-bus.service';
import { TasksService } from '../tasks/tasks.service';
import { ServerOperationsService } from './server-operations.service';

function setup() {
  const tasks = new TasksService();
  const bus = new StatusBusService();
  const events: unknown[] = [];
  bus.onOperationChanged((e) => events.push(e.operation?.step ?? null));
  return { ops: new ServerOperationsService(tasks, bus), tasks, events };
}

describe('ServerOperationsService', () => {
  it('locks the server for the duration, lets the body through, then unlocks', async () => {
    const { ops, tasks, events } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let bodyPassedLock = false;

    const taskId = ops.start(
      's1',
      'restoring',
      'Restore',
      'tester',
      async (t) => {
        t.step('Extracting');
        await gate;
        ops.assertNotBusy('s1'); // owner context: must not throw
        bodyPassedLock = true;
      },
    );

    expect(ops.get('s1')?.kind).toBe('restoring');
    expect(() => ops.assertNotBusy('s1')).toThrow(ConflictException);
    expect(() =>
      ops.start('s1', 'installing-world', 'x', 'tester', async () => {}),
    ).toThrow(ConflictException);
    expect(() => ops.assertNotBusy('other')).not.toThrow();

    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(bodyPassedLock).toBe(true);
    expect(ops.get('s1')).toBeNull();
    expect(tasks.getTask(taskId)?.state).toBe('done');
    expect(events.at(-1)).toBeNull();
    expect(events).toContain('Extracting');
  });

  it('unlocks when the body fails', async () => {
    const { ops, tasks } = setup();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const taskId = ops.start('s1', 'restoring', 'Restore', 'tester', () =>
      Promise.reject(new Error('boom')),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(ops.get('s1')).toBeNull();
    expect(tasks.getTask(taskId)?.state).toBe('failed');
  });
});
