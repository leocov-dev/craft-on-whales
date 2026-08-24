import { Injectable, OnModuleDestroy } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { and, gt, inArray, sql } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { playerEvents } from '../db/schema';
import { PlayerDataFileService } from './player-data-file.service';
import { InventorySnapshotService } from './inventory-snapshot.service';
import { NAME_RE } from './nbt-codec';

/**
 * Background DB-polling watcher: polls `player_events` for new join/death
 * rows and auto-snapshots that player's inventory. Extracted from
 * InventoryService (see `.plan/reviews/05-inventory-blueprints-items.md`,
 * "InventoryService is a God class").
 */
@Injectable()
export class InventoryWatcherService implements OnModuleDestroy {
  private watcherTimer: NodeJS.Timeout | null = null;
  private lastEventId = 0;

  constructor(
    private readonly dbService: DbService,
    private readonly playerDataFiles: PlayerDataFileService,
    private readonly snapshots: InventorySnapshotService,
  ) {}

  onModuleDestroy(): void {
    if (this.watcherTimer) clearInterval(this.watcherTimer);
  }

  /**
   * Poll player_events every `intervalMs` for new join/death rows and
   * snapshot that player's inventory. Starts from MAX(id) so old history is
   * never replayed. All errors are contained — the watcher can never crash
   * the panel. Called from onModuleInit (see InventoryModule wiring).
   */
  startSnapshotWatcher({
    intervalMs = 20000,
  }: { intervalMs?: number } = {}): void {
    if (this.watcherTimer) return;
    this.dbService.db
      .select({ maxId: sql<number | null>`MAX(id)` })
      .from(playerEvents)
      .then(([row]) => {
        this.lastEventId = Number(row && row.maxId) || 0;
      })
      .catch((err: unknown) => {
        console.error(
          '[inventory] snapshot watcher init failed:',
          err instanceof Error ? err.message : String(err),
        );
        this.lastEventId = 0;
      });
    this.watcherTimer = setInterval(() => {
      this.pollPlayerEvents().catch((err: Error) =>
        console.error('[inventory] snapshot watcher:', err.message),
      );
    }, intervalMs);
    this.watcherTimer.unref();
  }

  private async pollPlayerEvents(): Promise<void> {
    const rows = await this.dbService.db
      .select({
        id: playerEvents.id,
        serverId: playerEvents.serverId,
        type: playerEvents.type,
        player: playerEvents.player,
      })
      .from(playerEvents)
      .where(
        and(
          gt(playerEvents.id, this.lastEventId),
          inArray(playerEvents.type, ['join', 'death']),
        ),
      )
      .orderBy(playerEvents.id)
      .limit(200);
    for (const row of rows) {
      this.lastEventId = Math.max(this.lastEventId, Number(row.id));
      const player = row.player == null ? null : String(row.player);
      if (!player || !NAME_RE.test(player)) continue;
      try {
        const serverId = String(row.serverId);
        const { byName } = this.playerDataFiles.usercacheMaps(serverId);
        const uuid = byName.get(player.toLowerCase());
        if (!uuid) continue; // never joined far enough to be cached
        if (
          !fs.existsSync(
            path.join(
              await this.playerDataFiles.playerdataDir(serverId),
              `${uuid}.dat`,
            ),
          )
        )
          continue; // no .dat yet
        await this.snapshots.snapshot(serverId, uuid, String(row.type));
        await this.snapshots.pruneSnapshots(serverId);
      } catch {
        // One failed snapshot (corrupt file, deleted server, …) must not stop the sweep.
      }
    }
  }
}
