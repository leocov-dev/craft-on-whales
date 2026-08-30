/**
 * The one method ServerLifecycleService actually needs from SchedulerService
 * (to disarm a server's cron jobs on delete) — injected via this token
 * instead of `import type` + a lazy `require()` at the `@Inject`/`forwardRef`
 * site. ServersModule still needs `forwardRef(() => SchedulerModule)` since
 * the module cycle itself is genuine, but this class no longer does.
 */
export interface SchedulerContract {
  deleteSchedule(id: string, opts?: { actor?: string }): Promise<void>;
}

export const SCHEDULER_CONTRACT = Symbol('SCHEDULER_CONTRACT');
