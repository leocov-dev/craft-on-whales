import { AsyncLocalStorage } from 'node:async_hooks';
import { ConflictException, Injectable } from '@nestjs/common';
import type {
  ServerOperation,
  ServerOperationKind,
} from '../../../shared/types/servers';
import { StatusBusService } from '../status-bus/status-bus.service';
import { TasksService } from '../tasks/tasks.service';
import type { TaskHandle } from '../tasks/tasks.types';

const KIND_LABEL: Record<ServerOperationKind, string> = {
  restoring: 'restoring a backup',
  'installing-world': 'installing a world',
};

/**
 * Per-server "long operation in progress" registry (backup restore, world
 * install). Deliberately in-memory rather than a `servers.status` value:
 * ServerLifecycleService.refreshStatuses() and DockerWatcherService
 * re-derive that column from Docker and would overwrite a transitional
 * state. The operation is surfaced on the server view model and pushed over
 * `/ws/status`; lifecycle ops are refused through ServerLocksService.guard
 * while one is active. Lost on restart, like tasks.
 */
@Injectable()
export class ServerOperationsService {
  private readonly active = new Map<string, ServerOperation>();
  // The operation's own body (e.g. restore calling stopServer) must pass the
  // lock it holds; everything else on that server gets a 409.
  private readonly owner = new AsyncLocalStorage<string>();

  constructor(
    private readonly tasks: TasksService,
    private readonly statusBus: StatusBusService,
  ) {}

  get(serverId: string): ServerOperation | null {
    return this.active.get(serverId) ?? null;
  }

  assertNotBusy(serverId: string): void {
    const op = this.active.get(serverId);
    if (op && this.owner.getStore() !== serverId)
      throw new ConflictException(
        `This server is busy ${KIND_LABEL[op.kind]} — wait for it to finish`,
      );
  }

  /**
   * Locks `serverId`, runs `fn` as a tracked task in the background and
   * returns the task id. The lock is taken synchronously, so a second
   * caller (or lifecycle op) sees the 409 immediately.
   */
  start(
    serverId: string,
    kind: ServerOperationKind,
    title: string,
    actor: string,
    fn: (t: TaskHandle) => Promise<unknown>,
  ): string {
    this.assertNotBusy(serverId);
    const task = this.tasks.createTask(title, { serverId, actor });
    const op: ServerOperation = {
      kind,
      step: 'Starting…',
      percent: null,
      taskId: task.id,
    };
    this.active.set(serverId, op);
    this.publish(serverId, op);

    const update = (step: string | null, percent: number | null) => {
      if (this.active.get(serverId) !== op) return;
      if (step !== null) op.step = step;
      op.percent = percent;
      this.publish(serverId, { ...op });
    };
    const handle: TaskHandle = {
      ...task,
      step: (label) => {
        task.step(label);
        update(label, null);
      },
      progress: (current, total = 0) => {
        task.progress(current, total);
        update(
          null,
          total > 0 ? Math.min(100, Math.round((current / total) * 100)) : null,
        );
      },
    };

    this.owner.run(serverId, () => {
      Promise.resolve()
        .then(() => fn(handle))
        .then((result) => task.done(result))
        .catch((err: Error) => {
          console.error(`[operation] ${title}:`, err.message);
          task.fail(err);
        })
        .finally(() => {
          this.active.delete(serverId);
          this.publish(serverId, null);
        });
    });
    return task.id;
  }

  private publish(serverId: string, operation: ServerOperation | null): void {
    this.statusBus.emitOperationChanged({ serverId, operation });
  }
}
