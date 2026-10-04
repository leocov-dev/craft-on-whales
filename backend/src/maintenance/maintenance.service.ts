import { Injectable, Logger } from '@nestjs/common';
import { PanelDbService } from './panel-db.service';
import { RetentionService } from './retention.service';

/**
 * The scheduled `db-maintenance` task: bound the tables that grow without
 * limit, then snapshot the panel database. Each step is isolated so a failing
 * prune never costs you the day's snapshot (or the reverse), and failures are
 * logged rather than thrown: this runs unattended at 04:15.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    private readonly retention: RetentionService,
    private readonly panelDb: PanelDbService,
  ) {}

  async run(): Promise<void> {
    try {
      const r = await this.retention.pruneAll();
      if (r.playerEvents || r.playerSessions || r.events || r.apiCache) {
        this.logger.log(
          `Pruned old rows: ${r.playerEvents} player events, ${r.playerSessions} player sessions, ${r.events} events, ${r.apiCache} cache entries.`,
        );
      }
    } catch (err) {
      this.logger.error(`Pruning old rows failed: ${errMsg(err)}`);
    }
    try {
      const s = await this.panelDb.snapshot();
      if (s) {
        this.logger.log(
          `Snapshotted the panel database to backups/_panel/${s.file} (${s.bytes} bytes, ${s.elapsedMs} ms${s.pruned ? `, removed ${s.pruned} old` : ''}).`,
        );
      }
    } catch (err) {
      this.logger.error(`The panel database snapshot failed: ${errMsg(err)}`);
    }
  }
}

const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
