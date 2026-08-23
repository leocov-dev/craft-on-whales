/** `GET /api/schedules`'s per-schedule shape. */
export interface ScheduleViewModel {
  id: string;
  serverId: string | null;
  server: string;
  task: string;
  taskType: string;
  cron: string;
  payload: Record<string, unknown>;
  enabled: boolean;
  lastRun: string | null;
  lastRunMs: number | null;
  next: string | null;
  nextMs: number | null;
}

export interface TaskTypeOption {
  value: string;
  label: string;
  serverScoped: boolean;
}

/** `POST /api/schedules` request body. */
export interface CreateScheduleInput {
  serverId?: string | null;
  taskType: string;
  cron: string;
  payload?: Record<string, unknown>;
  enabled?: boolean;
}
