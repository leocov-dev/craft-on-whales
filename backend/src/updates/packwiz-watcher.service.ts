import { BadRequestException, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { EventsService } from '../events/events.service';
import { ServerLifecycleService } from '../servers/server-lifecycle.service';
import { PacksService } from '../packs/packs.service';
import { PackwizApiService } from '../mods/packwiz-api.service';
import { UpdateCheckerService } from './update-checker.service';
import { serverPacks, updateChecks } from '../db/schema';

/**
 * packwiz has no panel-side version selection (mods are fully author-
 * controlled — see PacksService.latestFor's packwiz branch), so it's kept
 * out of UpdateCheckerService.checkAll() entirely. Instead this watcher
 * polls every packwiz server's pack.toml on its own 5-minute schedule
 * (`packwiz-check` in SchedulerService), compares the resolved index hash
 * against the pin recorded at last restart, and either surfaces a restart
 * notice (reusing the same `update_checks` cache the Updates page already
 * reads) or, for servers opted into `server_packs.auto_restart_on_pack_change`,
 * restarts the container itself and re-pins to the new hash.
 */
@Injectable()
export class PackwizWatcherService {
  constructor(
    private readonly dbService: DbService,
    private readonly events: EventsService,
    private readonly lifecycle: ServerLifecycleService,
    private readonly packs: PacksService,
    private readonly packwiz: PackwizApiService,
    private readonly updateChecker: UpdateCheckerService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  async checkAll({ actor = 'scheduler' }: { actor?: string } = {}): Promise<{
    restarted: string[];
  }> {
    const restarted: string[] = [];
    const rows = await this.db
      .select()
      .from(serverPacks)
      .where(eq(serverPacks.platform, 'packwiz'));
    for (const pack of rows) {
      try {
        const resolved = await this.packwiz.resolvePack(pack.projectRef);
        const changed = resolved.indexHash !== pack.pinnedVersionId;
        const latestName =
          resolved.pack.version || resolved.indexHash.slice(0, 12);
        await this.updateChecker.upsertCheck(
          'pack',
          pack.serverId,
          pack.pinnedVersionName,
          {
            isNew: changed,
            latestId: changed ? resolved.indexHash : null,
            latestName: changed ? latestName : null,
            changelogUrl: null,
          },
        );
        if (changed && pack.autoRestartOnPackChange) {
          await this.restartAndRepin(
            pack.serverId,
            {
              id: resolved.indexHash,
              name: latestName,
            },
            { actor },
          );
          restarted.push(pack.serverId);
        }
      } catch {
        /* pack.toml unreachable this cycle — keep the old cache entry */
      }
    }
    return { restarted };
  }

  /** Manual "restart now" from the Mods tab's notice. */
  async applyNow(
    serverId: string,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<{ changed: boolean; hash: string }> {
    const pack = await this.packs.getPack(serverId);
    if (!pack || pack.platform !== 'packwiz')
      throw new BadRequestException('This server has no managed packwiz pack');
    const resolved = await this.packwiz.resolvePack(pack.projectRef);
    if (resolved.indexHash === pack.pinnedVersionId)
      return { changed: false, hash: resolved.indexHash };
    const latestName = resolved.pack.version || resolved.indexHash.slice(0, 12);
    await this.restartAndRepin(
      serverId,
      { id: resolved.indexHash, name: latestName },
      { actor },
    );
    return { changed: true, hash: resolved.indexHash };
  }

  private async restartAndRepin(
    serverId: string,
    latest: { id: string; name: string },
    { actor }: { actor: string },
  ): Promise<void> {
    const [previous] = await this.db
      .select()
      .from(serverPacks)
      .where(eq(serverPacks.serverId, serverId))
      .limit(1);
    await this.lifecycle.restartServer(serverId, { actor });
    await this.db
      .update(serverPacks)
      .set({
        pinnedVersionId: latest.id,
        pinnedVersionName: latest.name,
        previousVersionId: previous ? previous.pinnedVersionId : null,
        previousVersionName: previous ? previous.pinnedVersionName : null,
      })
      .where(eq(serverPacks.serverId, serverId));
    // Caught up — clear the "restart needed" notice immediately rather than
    // waiting up to 5 minutes for the next checkAll() to notice.
    await this.db
      .delete(updateChecks)
      .where(
        and(
          eq(updateChecks.subjectType, 'pack'),
          eq(updateChecks.subjectId, serverId),
        ),
      );
    this.events.recordEvent({
      serverId,
      actor,
      type: 'modpack-updated',
      summary: `Packwiz pack changed — restarted (${latest.name})`,
    });
  }
}
