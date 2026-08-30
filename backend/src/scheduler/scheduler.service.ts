import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  OnModuleInit,
} from '@nestjs/common';
import { Cron } from 'croner';
import { nanoid } from 'nanoid';
import { eq, isNull, and } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { schedules, servers } from '../db/schema';
import { EventsService } from '../events/events.service';
import { SettingsService } from '../settings/settings.service';
import { ContainerService } from '../docker/container.service';
import { rcon } from '../utils/rcon';
import { StorageIndexService } from '../storage/storage-index.service';
import { DataRootService } from '../storage/data-root.service';
import { SessionService } from '../auth/session.service';
import { BackupsService } from '../worlds/backups.service';
import { ServerLifecycleService } from '../servers/server-lifecycle.service';
import { UpdateCheckerService } from '../updates/update-checker.service';
import type {
  CreateScheduleInput,
  ScheduleViewModel,
} from '../../../shared/types/schedules';

export type { CreateScheduleInput };
/** @deprecated use {@link ScheduleViewModel} — kept as an alias so existing call sites don't need touching. */
export type ScheduleView = ScheduleViewModel;

type ScheduleRow = typeof schedules.$inferSelect;

type TaskType = keyof typeof TASK_TYPES;

export const TASK_TYPES = {
  restart: { label: 'Restart server', serverScoped: true },
  backup: { label: 'Backup', serverScoped: true },
  stop: { label: 'Stop server', serverScoped: true },
  start: { label: 'Start server', serverScoped: true },
  rcon: { label: 'Run command', serverScoped: true },
  'update-check': { label: 'Update check', serverScoped: false },
  'storage-scan': { label: 'Storage re-scan', serverScoped: false },
  'tmp-clean': { label: 'Purge tmp', serverScoped: false },
} as const;

/**
 * Cron scheduler (croner): per-server tasks (restart/backup/rcon/stop/start)
 * and global maintenance (update check, storage rescan, tmp cleanup, backup
 * pruning). Every firing is a history event; next-run times come from
 * croner. Ports `src/services/scheduler.ts` as one service — the legacy
 * file interleaves job-registration/execution/CRUD tightly enough (all three
 * share the in-memory `jobs` map and the same `schedule()`/`stopJob()`
 * primitives) that splitting further would be artificial.
 *
 * `ServerLifecycleService` needs `deleteSchedule()` to disarm a server's
 * cron jobs on delete (`servers.ts` and `scheduler.ts` require each other in
 * the legacy code — a genuine bidirectional cycle per the plan's
 * require-cycle audit). Resolved here via `forwardRef()` on both sides
 * rather than the `TODO(SchedulerModule)` marker that stood in for it.
 */
@Injectable()
export class SchedulerService implements OnModuleInit {
  private readonly jobs = new Map<string, InstanceType<typeof Cron>>();

  constructor(
    private readonly dbService: DbService,
    private readonly events: EventsService,
    private readonly settings: SettingsService,
    private readonly containers: ContainerService,
    private readonly indexer: StorageIndexService,
    private readonly dataRoot: DataRootService,
    private readonly sessions: SessionService,
    private readonly backups: BackupsService,
    @Inject(forwardRef(() => ServerLifecycleService))
    private readonly lifecycle: ServerLifecycleService,
    private readonly updateChecker: UpdateCheckerService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  async onModuleInit(): Promise<void> {
    await this.startScheduler();
  }

  private async runTask(job: ScheduleRow): Promise<void> {
    const payload = JSON.parse(job.payloadJson || '{}') as Record<
      string,
      unknown
    >;
    const actor = 'scheduler';
    switch (job.taskType) {
      case 'restart':
        await this.lifecycle.restartServer(job.serverId!, { actor });
        break;
      case 'stop':
        await this.lifecycle.stopServer(job.serverId!, { actor });
        break;
      case 'start':
        await this.lifecycle.startServer(job.serverId!, { actor });
        break;
      case 'backup':
        await this.backups.createBackup(job.serverId!, {
          reason: 'scheduled',
          actor,
        });
        break;
      case 'rcon': {
        const command =
          typeof payload.command === 'string' ? payload.command : 'list';
        const out = await rcon(
          this.containers,
          job.serverId!,
          command.split(/\s+/),
        );
        this.events.recordEvent({
          serverId: job.serverId,
          actor,
          type: 'rcon',
          summary: `Scheduled RCON: ${command}`,
          details: { output: out.slice(0, 1000) },
        });
        break;
      }
      case 'update-check':
        // checkAll() already records its own 'update-check' event with the
        // findings summary — no separate schedule-fired bookkeeping needed
        // here beyond what runTask's caller (schedule()) already records.
        await this.updateChecker.checkAll({ actor });
        break;
      case 'storage-scan':
        await this.indexer.scan();
        await this.indexer.enforceStrictQuotas();
        break;
      case 'tmp-clean':
        // Scheduled path only clears entries older than 24h so in-flight
        // downloads/uploads survive the 04:30 sweep (boot still wipes fully).
        this.dataRoot.cleanTmp({ olderThanMs: 24 * 60 * 60 * 1000 });
        await this.sessions.pruneExpiredSessions();
        break;
      default:
        throw new Error(`Unknown task type ${job.taskType}`);
    }
  }

  private async schedule(job: ScheduleRow): Promise<void> {
    this.stopJob(job.id);
    if (!job.enabled) return;
    try {
      // protect: true — a still-running invocation blocks the next firing
      // instead of overlapping it (e.g. hour-long backups on a 5-min cron).
      // timezone: without it croner evaluates the expression in the SYSTEM
      // timezone (UTC in most containers), not the operator's configured
      // one — "0 3 * * *" would then fire at 3am UTC, not 3am in Settings.
      const timezone = await this.settings.getTimezone();
      const cron = new Cron(
        job.cron,
        { catch: true, protect: true, timezone },
        async () => {
          await this.db
            .update(schedules)
            .set({
              lastRunAt: new Date()
                .toISOString()
                .slice(0, 19)
                .replace('T', ' '),
            })
            .where(eq(schedules.id, job.id));
          this.events.recordEvent({
            serverId: job.serverId || null,
            actor: 'scheduler',
            type: 'schedule-fired',
            summary: `Scheduled task fired: ${TASK_TYPES[job.taskType as TaskType]?.label || job.taskType}`,
          });
          try {
            await this.runTask(job);
          } catch (err) {
            this.events.recordEvent({
              serverId: job.serverId || null,
              actor: 'scheduler',
              type: 'schedule-failed',
              summary: `Scheduled ${job.taskType} failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        },
      );
      this.jobs.set(job.id, cron);
    } catch (err) {
      console.error(
        `[scheduler] invalid cron "${job.cron}" for ${job.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private stopJob(id: string): void {
    const existing = this.jobs.get(id);
    if (existing) {
      existing.stop();
      this.jobs.delete(id);
    }
  }

  /** Re-arm every schedule against the CURRENT timezone — call after it
   *  changes in Settings, or already-running jobs keep firing on the old
   *  one until the panel restarts. */
  async rearmAll(): Promise<void> {
    for (const job of await this.db.select().from(schedules))
      await this.schedule(job);
  }

  private async startScheduler(): Promise<void> {
    await this.seedGlobalDefaults();
    for (const job of await this.db.select().from(schedules))
      await this.schedule(job);

    console.log(`[scheduler] ${this.jobs.size} job(s) armed`);
  }

  /** Global maintenance tasks exist from first boot; user can disable/edit. */
  private async seedGlobalDefaults(): Promise<void> {
    const defaults: { taskType: string; cron: string }[] = [
      { taskType: 'update-check', cron: '0 3 * * *' },
      { taskType: 'storage-scan', cron: '0 */6 * * *' },
      { taskType: 'tmp-clean', cron: '30 4 * * *' },
    ];
    for (const d of defaults) {
      const [exists] = await this.db
        .select({ id: schedules.id })
        .from(schedules)
        .where(
          and(eq(schedules.taskType, d.taskType), isNull(schedules.serverId)),
        )
        .limit(1);
      if (!exists) {
        await this.db.insert(schedules).values({
          id: `sch_${nanoid(8)}`,
          serverId: null,
          taskType: d.taskType,
          cron: d.cron,
          payloadJson: '{}',
          enabled: true,
        });
      }
    }
  }

  async createSchedule(
    {
      serverId = null,
      taskType,
      cron,
      payload = {},
      enabled = true,
    }: CreateScheduleInput,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<ScheduleView | undefined> {
    if (!TASK_TYPES[taskType as TaskType])
      throw new BadRequestException(`Unknown task type ${taskType}`);
    new Cron(cron, { timezone: await this.settings.getTimezone() }); // validates; throws on bad expression
    const id = `sch_${nanoid(8)}`;
    await this.db.insert(schedules).values({
      id,
      serverId,
      taskType,
      cron,
      payloadJson: JSON.stringify(payload),
      enabled,
    });
    const [job] = await this.db
      .select()
      .from(schedules)
      .where(eq(schedules.id, id))
      .limit(1);
    await this.schedule(job!);
    this.events.recordEvent({
      serverId,
      actor,
      type: 'schedule-created',
      summary: `Schedule created: ${TASK_TYPES[taskType as TaskType].label} (${cron})`,
    });
    return (await this.listSchedules()).find((s) => s.id === id);
  }

  async setEnabled(
    id: string,
    enabled: boolean,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<void> {
    await this.db
      .update(schedules)
      .set({ enabled })
      .where(eq(schedules.id, id));
    const [job] = await this.db
      .select()
      .from(schedules)
      .where(eq(schedules.id, id))
      .limit(1);
    if (job) await this.schedule(job);
    this.events.recordEvent({
      serverId: job?.serverId || null,
      actor,
      type: 'schedule-toggled',
      summary: `Schedule ${enabled ? 'enabled' : 'disabled'}: ${job?.taskType}`,
    });
  }

  /** Disarm and delete a schedule. Also called by `ServerLifecycleService`
   *  (via `forwardRef`) to disarm a server's cron jobs before it's deleted. */
  async deleteSchedule(
    id: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<void> {
    const [job] = await this.db
      .select()
      .from(schedules)
      .where(eq(schedules.id, id))
      .limit(1);
    this.stopJob(id);
    await this.db.delete(schedules).where(eq(schedules.id, id));
    if (job) {
      this.events.recordEvent({
        serverId: job.serverId,
        actor,
        type: 'schedule-deleted',
        summary: `Schedule deleted: ${job.taskType}`,
      });
    }
  }

  async listSchedules(): Promise<ScheduleView[]> {
    const rows = await this.db.select().from(schedules);
    const tz = await this.settings.getTimezone();
    const results: ScheduleView[] = [];
    for (const s of rows) {
      let next: string | null = null;
      let nextMs: number | null = null;
      try {
        const nextRun = new Cron(s.cron, { timezone: tz }).nextRun();
        if (nextRun) {
          next = nextRun.toISOString().replace('T', ' ').slice(0, 16);
          nextMs = nextRun.getTime();
        }
      } catch {
        /* invalid cron stays null */
      }
      // lastRunAt is SQLite datetime('now') — UTC without a zone marker.
      const lastRunMs = s.lastRunAt
        ? Date.parse(s.lastRunAt.replace(' ', 'T') + 'Z')
        : null;
      const server = s.serverId
        ? (
            await this.db
              .select({ displayName: servers.displayName })
              .from(servers)
              .where(eq(servers.id, s.serverId))
              .limit(1)
          )[0]
        : null;
      results.push({
        id: s.id,
        serverId: s.serverId,
        server: server ? server.displayName : '— global —',
        task: TASK_TYPES[s.taskType as TaskType]?.label || s.taskType,
        taskType: s.taskType,
        cron: s.cron,
        payload: JSON.parse(s.payloadJson || '{}') as Record<string, unknown>,
        enabled: Boolean(s.enabled),
        lastRun: s.lastRunAt,
        lastRunMs: Number.isFinite(lastRunMs) ? lastRunMs : null,
        next,
        nextMs,
      });
    }
    return results;
  }
}
