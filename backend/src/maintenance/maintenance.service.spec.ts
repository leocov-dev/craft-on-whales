import { Logger } from '@nestjs/common';
import { MaintenanceService } from './maintenance.service';
import type { PanelDbService } from './panel-db.service';
import type { RetentionService } from './retention.service';

describe('MaintenanceService.run', () => {
  const snapshotOk = {
    file: 'panel-2026-01-01-04-15-00.db',
    bytes: 10,
    elapsedMs: 1,
    pruned: 0,
  };
  let errors: string[];

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    errors = [];
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((message: unknown) => {
        errors.push(String(message));
      });
  });
  afterEach(() => jest.restoreAllMocks());

  const make = (pruneAll: jest.Mock, snapshot: jest.Mock) => ({
    service: new MaintenanceService(
      { pruneAll } as unknown as RetentionService,
      { snapshot } as unknown as PanelDbService,
    ),
    pruneAll,
    snapshot,
  });

  it('still snapshots when pruning fails', async () => {
    const { service, snapshot } = make(
      jest.fn().mockRejectedValue(new Error('prune boom')),
      jest.fn().mockResolvedValue(snapshotOk),
    );
    await expect(service.run()).resolves.toBeUndefined();
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(errors[0]).toMatch(/prune boom/);
  });

  it('still prunes when the snapshot fails, without throwing', async () => {
    const { service, pruneAll } = make(
      jest.fn().mockResolvedValue({
        playerEvents: 0,
        playerSessions: 0,
        events: 0,
        apiCache: 0,
      }),
      jest.fn().mockRejectedValue(new Error('disk full')),
    );
    await expect(service.run()).resolves.toBeUndefined();
    expect(pruneAll).toHaveBeenCalledTimes(1);
    expect(errors[0]).toMatch(/disk full/);
  });
});
