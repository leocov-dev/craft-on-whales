import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { servers } from '../db/schema';
import { EventsService } from '../events/events.service';
import { ServerQueryService } from '../servers/server-query.service';
import { PacksService } from './packs.service';

export interface PackwizTypeSweepResult {
  repaired: number;
  failed: number;
}

/**
 * Boot-time repair for servers whose `type` column still literally holds
 * `'PACKWIZ'`, written by installs applied before `PacksService.packEnv()`
 * learned to derive the real itzg/docker-minecraft-server TYPE from the
 * pack's declared loader — the image has no `TYPE=PACKWIZ` at all, so an
 * affected server fails to start ("Invalid TYPE: 'PACKWIZ'") every time.
 * Nothing else heals this: `ServerEnvironmentService.assembleEnv()` copies
 * `servers.type` verbatim into the container env on every start/recreate,
 * so the bad value survives indefinitely once written. Same shape of
 * problem, same fix pattern, as `PackPinSweepService` — see PACKS_NOTES.md.
 */
@Injectable()
export class PackwizTypeSweepService implements OnModuleInit {
  private readonly logger = new Logger(PackwizTypeSweepService.name);

  constructor(
    private readonly dbService: DbService,
    private readonly events: EventsService,
    private readonly query: ServerQueryService,
    private readonly packs: PacksService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  async onModuleInit(): Promise<void> {
    try {
      const result = await this.sweep();
      if (result.repaired || result.failed) {
        this.logger.log(
          `Legacy packwiz TYPE boot sweep: repaired ${result.repaired}, failed ${result.failed} (left as-is, will retry next boot).`,
        );
      }
    } catch (err) {
      // A sweep failure must never block boot — affected servers simply
      // keep failing to start until the next boot tries again, same as
      // before this existed.
      this.logger.error(
        'The legacy packwiz TYPE boot sweep failed.',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Re-fetches each affected server's pack.toml (via its own stored
   * PACKWIZ_URL, never a re-resolved "latest" reference) to read the
   * loader it currently declares, then patches `type` and flags a recreate
   * so the corrected TYPE takes effect on the server's next start.
   */
  async sweep(): Promise<PackwizTypeSweepResult> {
    let repaired = 0;
    let failed = 0;

    for (const server of await this.query.listServers()) {
      if (server.type !== 'PACKWIZ') continue;
      const packUrl = server.env.PACKWIZ_URL;
      if (!packUrl) {
        failed += 1;
        this.logger.warn(
          `Server ${server.id} has type='PACKWIZ' but no PACKWIZ_URL env — cannot re-derive its real container type.`,
        );
        continue;
      }
      try {
        const type = await this.packs.packwizType(packUrl);
        await this.db
          .update(servers)
          .set({ type, pendingRecreate: true })
          .where(eq(servers.id, server.id));
        this.events.recordEvent({
          serverId: server.id,
          actor: 'system',
          type: 'packwiz-type-repaired',
          summary: `Repaired legacy container type ('PACKWIZ' is not a valid image TYPE) to '${type}', derived from the pack's declared loader. Takes effect on next start.`,
        });
        repaired += 1;
      } catch (err) {
        failed += 1;
        this.logger.warn(
          `Server ${server.id}: could not re-derive TYPE from PACKWIZ_URL (${packUrl}) — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return { repaired, failed };
  }
}
