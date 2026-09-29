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

  /**
   * Polls a task until it leaves 'running', resolving with the final task (or rejecting on
   * failure). `onProgress` sees every poll, for callers that show `task.step`.
   */
  async waitFor<T = unknown>(
    taskId: string,
    {
      intervalMs = 1000,
      onProgress,
    }: { intervalMs?: number; onProgress?: (task: Task<T>) => void } = {},
  ): Promise<Task<T>> {
    for (;;) {
      const { task } = await tasksApi.get<T>(taskId);
      onProgress?.(task);
      if (task.state === 'done') return task;
      if (task.state === 'failed') throw new Error(task.error || 'Task failed');
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  },
};
