'use strict';

// Long-operation tracking: every slow job (pack install/upgrade, image pull,
// downloads, backups, world ops, blueprint import) runs as a registered task
// the UI polls for real progress — no more fake pulse bars.

const { nanoid } = require('nanoid');

const TTL_MS = 10 * 60 * 1000; // finished tasks linger for late polls

interface TaskExtra {
  requiresForce?: true;
  requiresVersionConfirm?: true;
  fromVersion?: string;
  toVersion?: string;
}

interface Task {
  id: string;
  title: string;
  serverId: string | null;
  actor: string;
  state: 'running' | 'done' | 'failed';
  stepLabel: string;
  current: number;
  total: number;
  logs: string[];
  result: unknown;
  error: string | null;
  extra?: TaskExtra;
  startedAt: number;
  finishedAt: number | null;
}

/** Error shape task.fail() reads optional force/version-confirm hints from. */
interface FailableError {
  message?: string;
  requiresForce?: boolean;
  requiresVersionConfirm?: boolean;
  fromVersion?: string;
  toVersion?: string;
}

const tasks = new Map<string, Task>(); // id -> task

interface CreateTaskOptions {
  serverId?: string | null;
  actor?: string;
}

interface TaskHandle {
  id: string;
  step(label: string): void;
  progress(current: number, total?: number): void;
  log(line: unknown): void;
  done(result?: unknown): void;
  fail(error: unknown): void;
}

/**
 * createTask('Installing pack …', {serverId}) → task handle:
 *   t.step('Downloading mods')          — set the current step label
 *   t.progress(received, total)         — numeric progress for the active step
 *   t.log('…')                          — append a detail line (kept last 50)
 *   t.done(result) / t.fail(error)      — finish
 * run(title, opts, fn) wraps a promise-returning fn with automatic done/fail.
 */
function createTask(title: string, { serverId = null, actor = 'system' }: CreateTaskOptions = {}): TaskHandle {
  const id = `task_${nanoid(10)}`;
  const task: Task = {
    id,
    title,
    serverId,
    actor,
    state: 'running', // running | done | failed
    stepLabel: 'Starting…',
    current: 0,
    total: 0,
    logs: [],
    result: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  tasks.set(id, task);

  const handle: TaskHandle = {
    id,
    step(label) {
      task.stepLabel = label;
      task.current = 0;
      task.total = 0;
    },
    progress(current, total = 0) {
      task.current = current;
      task.total = total;
    },
    log(line) {
      task.logs.push(String(line).slice(0, 300));
      if (task.logs.length > 50) task.logs.shift();
    },
    done(result = null) {
      task.state = 'done';
      task.result = result;
      task.finishedAt = Date.now();
      scheduleCleanup(id);
    },
    fail(error) {
      const err = error as FailableError | undefined;
      task.state = 'failed';
      task.error = err && err.message ? err.message : String(error);
      const extra: TaskExtra = {};
      if (err && err.requiresForce) extra.requiresForce = true;
      if (err && err.requiresVersionConfirm) {
        extra.requiresVersionConfirm = true;
        if (err.fromVersion) extra.fromVersion = err.fromVersion;
        if (err.toVersion) extra.toVersion = err.toVersion;
      }
      task.extra = Object.keys(extra).length ? extra : undefined;
      task.finishedAt = Date.now();
      scheduleCleanup(id);
    },
  };
  return handle;
}

/** Fire-and-track: returns the task id immediately; fn runs in background. */
function run(title: string, opts: CreateTaskOptions, fn: (t: TaskHandle) => Promise<unknown>): string {
  const t = createTask(title, opts);
  Promise.resolve()
    .then(() => fn(t))
    .then((result) => t.done(result))
    .catch((err: Error) => {
      console.error(`[task] ${title}:`, err.message);
      t.fail(err);
    });
  return t.id;
}

interface TaskView {
  id: string;
  title: string;
  serverId: string | null;
  state: 'running' | 'done' | 'failed';
  step: string;
  current: number;
  total: number;
  percent: number | null;
  logs: string[];
  result: unknown;
  error: string | null;
  requiresForce?: true;
  requiresVersionConfirm?: true;
  fromVersion?: string;
  toVersion?: string;
  elapsedMs: number;
}

function getTask(id: string): TaskView | null {
  const t = tasks.get(id);
  if (!t) return null;
  return {
    id: t.id,
    title: t.title,
    serverId: t.serverId,
    state: t.state,
    step: t.stepLabel,
    current: t.current,
    total: t.total,
    percent: t.total ? Math.min(100, Math.round((t.current / t.total) * 100)) : null,
    logs: t.logs.slice(-10),
    result: t.result,
    error: t.error,
    ...(t.extra || {}),
    elapsedMs: (t.finishedAt || Date.now()) - t.startedAt,
  };
}

function scheduleCleanup(id: string): void {
  setTimeout(() => tasks.delete(id), TTL_MS).unref();
}

/** Active (running) tasks + very recent finishers, for the global task tray. */
function listTasks(): TaskView[] {
  const out: TaskView[] = [];
  for (const t of tasks.values()) {
    if (t.state === 'running' || Date.now() - (t.finishedAt || 0) < 15000) {
      const view = getTask(t.id);
      if (view) out.push(view);
    }
  }
  return out.sort((a, b) => (a.state === 'running' ? -1 : 1) - (b.state === 'running' ? -1 : 1));
}

export { createTask, run, getTask, listTasks };
