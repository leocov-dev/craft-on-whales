import { Injectable } from '@nestjs/common';
import { nanoid } from 'nanoid';
import type {
  CreateTaskOptions,
  FailableError,
  Task,
  TaskHandle,
  TaskView,
} from './tasks.types';

const TTL_MS = 10 * 60 * 1000; // finished tasks linger for late polls

/**
 * Long-operation tracking: every slow job (pack install/upgrade, image pull,
 * downloads, backups, world ops, blueprint import) runs as a registered task
 * the UI polls for real progress. Ports `src/services/tasks.ts` — a plain
 * in-memory registry, no DB/cycle concerns.
 *
 * The `TaskHandle` returned by `createTask`/`run` is a structural type
 * (id/step/progress/log/done/fail) — `BackupsService`/`UpdateUpgradeService`
 * already declare their own local, narrower `task?: {...}` parameter types
 * that this handle satisfies structurally, so no changes were needed there
 * to wire a real task through: a caller does
 * `backups.createBackup(id, { task: tasksService.createTask(...) })`.
 */
@Injectable()
export class TasksService {
  private readonly tasks = new Map<string, Task>();

  /**
   * createTask('Installing pack …', {serverId}) → task handle:
   *   t.step('Downloading mods')          — set the current step label
   *   t.progress(received, total)         — numeric progress for the active step
   *   t.log('…')                          — append a detail line (kept last 50)
   *   t.done(result) / t.fail(error)      — finish
   */
  createTask(
    title: string,
    { serverId = null, actor = 'system' }: CreateTaskOptions = {},
  ): TaskHandle {
    const id = `task_${nanoid(10)}`;
    const task: Task = {
      id,
      title,
      serverId,
      actor,
      state: 'running',
      stepLabel: 'Starting…',
      current: 0,
      total: 0,
      logs: [],
      result: null,
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
    };
    this.tasks.set(id, task);

    const handle: TaskHandle = {
      id,
      step: (label) => {
        task.stepLabel = label;
        task.current = 0;
        task.total = 0;
      },
      progress: (current, total = 0) => {
        task.current = current;
        task.total = total;
      },
      log: (line) => {
        task.logs.push(String(line).slice(0, 300));
        if (task.logs.length > 50) task.logs.shift();
      },
      done: (result = null) => {
        task.state = 'done';
        task.result = result;
        task.finishedAt = Date.now();
        this.scheduleCleanup(id);
      },
      fail: (error) => {
        const err = error as FailableError | undefined;
        task.state = 'failed';
        task.error = err && err.message ? err.message : String(error);
        const extra: Task['extra'] = {};
        if (err && err.requiresForce) extra.requiresForce = true;
        if (err && err.requiresVersionConfirm) {
          extra.requiresVersionConfirm = true;
          if (err.fromVersion) extra.fromVersion = err.fromVersion;
          if (err.toVersion) extra.toVersion = err.toVersion;
        }
        task.extra = Object.keys(extra).length ? extra : undefined;
        task.finishedAt = Date.now();
        this.scheduleCleanup(id);
      },
    };
    return handle;
  }

  /** Fire-and-track: returns the task id immediately; fn runs in background. */
  run(
    title: string,
    opts: CreateTaskOptions,
    fn: (t: TaskHandle) => Promise<unknown>,
  ): string {
    const t = this.createTask(title, opts);
    Promise.resolve()
      .then(() => fn(t))
      .then((result) => t.done(result))
      .catch((err: Error) => {
        console.error(`[task] ${title}:`, err.message);
        t.fail(err);
      });
    return t.id;
  }

  getTask(id: string): TaskView | null {
    const t = this.tasks.get(id);
    if (!t) return null;
    return {
      id: t.id,
      title: t.title,
      serverId: t.serverId,
      state: t.state,
      step: t.stepLabel,
      current: t.current,
      total: t.total,
      percent: t.total
        ? Math.min(100, Math.round((t.current / t.total) * 100))
        : null,
      logs: t.logs.slice(-10),
      result: t.result,
      error: t.error,
      ...(t.extra || {}),
      elapsedMs: (t.finishedAt || Date.now()) - t.startedAt,
    };
  }

  private scheduleCleanup(id: string): void {
    setTimeout(() => this.tasks.delete(id), TTL_MS).unref();
  }

  /** Active (running) tasks + very recent finishers, for the global task tray. */
  listTasks(): TaskView[] {
    const out: TaskView[] = [];
    for (const t of this.tasks.values()) {
      if (t.state === 'running' || Date.now() - (t.finishedAt || 0) < 15000) {
        const view = this.getTask(t.id);
        if (view) out.push(view);
      }
    }
    return out.sort(
      (a, b) =>
        (a.state === 'running' ? -1 : 1) - (b.state === 'running' ? -1 : 1),
    );
  }
}
