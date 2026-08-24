// Wraps GET/POST /api/schedules, POST /api/schedules/:id/toggle,
// DELETE /api/schedules/:id, and GET /api/schedules/preview.

import { http } from './http';
import type {
  ScheduleViewModel,
  TaskTypeOption,
  CreateScheduleInput,
} from '../../../shared/types/schedules';

export type { ScheduleViewModel, TaskTypeOption, CreateScheduleInput };

interface SchedulesResponse {
  ok: true;
  schedules: ScheduleViewModel[];
  taskTypes: TaskTypeOption[];
}

interface PreviewResponse {
  ok: true;
  cron: string;
  runs: string[];
}

export const schedulesApi = {
  list: () => http.get<SchedulesResponse>('/api/schedules'),
  preview: (cron: string) =>
    http.get<PreviewResponse>(`/api/schedules/preview?cron=${encodeURIComponent(cron)}`),
  // schedule can be undefined in principle (SchedulerService.createSchedule's
  // real return type) — always defined in practice right after an insert,
  // but the type stays honest about it rather than asserting.
  create: (input: CreateScheduleInput) =>
    http.post<{ ok: true; schedule: ScheduleViewModel | undefined }>('/api/schedules', input),
  toggle: (id: string, enabled: boolean) =>
    http.post<{ ok: true }>(`/api/schedules/${id}/toggle`, { enabled }),
  remove: (id: string) => http.delete<{ ok: true }>(`/api/schedules/${id}`),
};
