// Wraps GET /api/tasks/:id — the polling endpoint every task-based action
// (backups, pack upgrade/rollback, update checks, from-pack/from-mods
// creation) reports progress through. See src/services/tasks.ts.

import { http } from './http';
import type { TaskState, Task } from '../../../shared/types/tasks';

export type { TaskState, Task };

interface TaskResponse<T> {
  ok: true;
  task: Task<T>;
}

export const tasksApi = {
  get: <T = unknown>(id: string) => http.get<TaskResponse<T>>(`/api/tasks/${id}`),

  /** Polls a task until it leaves 'running', resolving with the final task (or rejecting on failure). */
  async waitFor<T = unknown>(
    taskId: string,
    { intervalMs = 1000 }: { intervalMs?: number } = {},
  ): Promise<Task<T>> {
    for (;;) {
      const { task } = await tasksApi.get<T>(taskId);
      if (task.state === 'done') return task;
      if (task.state === 'failed') throw new Error(task.error || 'Task failed');
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  },
};
