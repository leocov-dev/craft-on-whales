import type { Task as TaskView } from '../../../shared/types/tasks';

export type { TaskView };

export interface TaskExtra {
  requiresForce?: true;
  requiresVersionConfirm?: true;
  fromVersion?: string;
  toVersion?: string;
}

/** The mutable in-memory task record — internal only, never serialized directly (see {@link TaskView}). */
export interface Task {
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
export interface FailableError {
  message?: string;
  requiresForce?: boolean;
  requiresVersionConfirm?: boolean;
  fromVersion?: string;
  toVersion?: string;
}

export interface CreateTaskOptions {
  serverId?: string | null;
  actor?: string;
}

export interface TaskHandle {
  id: string;
  step(label: string): void;
  progress(current: number, total?: number): void;
  log(line: unknown): void;
  done(result?: unknown): void;
  fail(error: unknown): void;
}

