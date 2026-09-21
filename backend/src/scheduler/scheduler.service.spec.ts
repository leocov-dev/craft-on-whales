import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { EventsService } from '../events/events.service';
import { SettingsService } from '../settings/settings.service';
import { ContainerService } from '../docker/container.service';
import { StorageIndexService } from '../storage/storage-index.service';
import { DataRootService } from '../storage/data-root.service';
import { SessionService } from '../auth/session.service';
import { BackupsService } from '../worlds/backups.service';
import { ServerLifecycleService } from '../servers/server-lifecycle.service';
import { UpdateCheckerService } from '../updates/update-checker.service';
import { SchedulerService } from './scheduler.service';

// createSchedule() only touches the DB/events after cron validation passes,
// so every dependency below is a bare stub — invalid-cron cases never reach
// them, and onModuleInit() is never triggered (moduleRef.compile() doesn't
// run lifecycle hooks), so no DB schema is needed either.
describe('SchedulerService.createSchedule — invalid cron handling', () => {
  let service: SchedulerService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        SchedulerService,
        { provide: DbService, useValue: { db: {} } },
        { provide: EventsService, useValue: { recordEvent: jest.fn() } },
        {
          provide: SettingsService,
          useValue: { getTimezone: () => Promise.resolve('UTC') },
        },
        { provide: ContainerService, useValue: {} },
        { provide: StorageIndexService, useValue: {} },
        { provide: DataRootService, useValue: {} },
        { provide: SessionService, useValue: {} },
        { provide: BackupsService, useValue: {} },
        { provide: ServerLifecycleService, useValue: {} },
        { provide: UpdateCheckerService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(SchedulerService);
  });

  it('rejects an unknown task type with a 4xx before touching cron', async () => {
    await expect(
      service.createSchedule({
        taskType: 'not-a-real-task',
        cron: '0 3 * * *',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a cron string with the wrong field count as a 4xx with a specific reason', async () => {
    const err = await service
      .createSchedule({ taskType: 'backup', cron: '* * * *' })
      .catch((e: unknown) => e as { status?: number; message?: string });
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/invalid cron expression/i);
  });

  it('rejects an out-of-range field (minute 99) as a 4xx naming the bad field', async () => {
    const err = await service
      .createSchedule({ taskType: 'backup', cron: '99 * * * *' })
      .catch((e: unknown) => e as { status?: number; message?: string });
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/minute/i);
  });

  it('rejects an empty cron string as a 4xx', async () => {
    await expect(
      service.createSchedule({ taskType: 'restart', cron: '' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets a valid 5-field cron pass validation (fails later, on the stub DB, not on cron)', async () => {
    // createSchedule only reaches the DB insert after cron validation
    // succeeds; the stub DbService above has no real `.insert()`, so a valid
    // cron surfaces a *different* failure than the cron-validation path —
    // proving the cron check itself let it through.
    await expect(
      service.createSchedule({ taskType: 'restart', cron: '0 3 * * *' }),
    ).rejects.not.toThrow(/invalid cron expression/i);
  });
});
