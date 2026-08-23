export type TaskState = 'running' | 'done' | 'failed';

/**
 * `GET /api/tasks/:id`'s task shape — every task-based action (backups,
 * pack upgrade/rollback, update checks, from-pack/from-mods creation)
 * reports progress through this. Generic over `result` so callers can type
 * the payload a specific task type resolves with.
 */
export interface Task<T = unknown> {
  id: string;
  title: string;
  serverId: string | null;
  state: TaskState;
  step: string;
  current: number;
  total: number;
  percent: number | null;
  logs: string[];
  result: T;
  error: string | null;
  requiresForce?: true;
  requiresVersionConfirm?: true;
  fromVersion?: string;
  toVersion?: string;
  elapsedMs: number;
}
