import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { servers, serverPacks } from '../db/schema';
import { EventsService } from '../events/events.service';
import { ServerQueryService } from '../servers/server-query.service';
import {
  PackPinGuardService,
  type UnpinnedPackSelector,
} from '../servers/pack-pin-guard.service';

export interface PackPinSweepResult {
  pinned: number;
  flagged: number;
}

/**
 * Boot-time repair for servers that already carry an unpinned modpack
 * selector — created before `PackPinGuardService` existed, or written
 * directly against the DB/API outside the panel. Idempotent: a server that
 * is already pinned (or already flagged with nothing new to learn) matches
 * nothing on a later run. See `PACKS_NOTES.md` for why this never
 * re-resolves "latest".
 */
@Injectable()
export class PackPinSweepService implements OnModuleInit {
  private readonly logger = new Logger(PackPinSweepService.name);

  constructor(
    private readonly dbService: DbService,
    private readonly events: EventsService,
    private readonly query: ServerQueryService,
    private readonly guard: PackPinGuardService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  async onModuleInit(): Promise<void> {
    try {
      const result = await this.sweep();
      if (result.pinned || result.flagged) {
        this.logger.log(
          `Unpinned-modpack boot sweep: pinned ${result.pinned}, flagged ${result.flagged} for manual review in Settings.`,
        );
      }
    } catch (err) {
      // A sweep failure must never block boot — the servers it would have
      // touched simply keep re-resolving "latest" until the next boot tries
      // again, same as before this existed.
      this.logger.error(
        'The unpinned-modpack boot sweep failed.',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Pin every unpinned modpack selector to the version already installed,
   * using ONLY the panel's own `server_packs` record — never a freshly
   * resolved "latest" (that re-resolution is the bug this closes). A
   * record is trusted only when its platform AND project reference match
   * the selector still in env: a server_packs row left over from a
   * different pack (the selector was hand-edited to point elsewhere without
   * going through PacksService.applyPack) must never be used to mis-pin the
   * wrong version onto the wrong pack. No trustworthy record → the server is
   * flagged (`packPinNeedsReview`) instead of guessed at; Settings shows a
   * warning with a manual version picker.
   */
  async sweep(): Promise<PackPinSweepResult> {
    let pinned = 0;
    let flagged = 0;

    for (const server of await this.query.listServers()) {
      const issues = this.guard.unpinnedSelectors(server.type, server.env);
      if (!issues.length) continue;

      const [packRow] = await this.db
        .select()
        .from(serverPacks)
        .where(eq(serverPacks.serverId, server.id))
        .limit(1);

      const env: Record<string, string> = { ...server.env };
      const applied: UnpinnedPackSelector[] = [];
      let anyUnresolved = false;

      for (const issue of issues) {
        const trustworthy =
          packRow &&
          packRow.platform === issue.platform &&
          (!issue.projectRef ||
            packRow.projectRef.toLowerCase() === issue.projectRef);
        if (!trustworthy) {
          anyUnresolved = true;
          this.logger.warn(
            `Server ${server.id} has an unpinned ${issue.platform} selector and no trustworthy installed-version record — pin it manually in Settings.`,
          );
          continue;
        }
        env[issue.pinKey] = packRow.pinnedVersionId;
        applied.push(issue);
      }

      if (applied.length) {
        await this.db
          .update(servers)
          .set({
            envJson: JSON.stringify(env),
            pendingRecreate: true,
            packPinNeedsReview: anyUnresolved,
          })
          .where(eq(servers.id, server.id));

        for (const issue of applied) {
          this.events.recordEvent({
            serverId: server.id,
            actor: 'system',
            type: 'pack-pinned',
            summary: `Locked the ${issue.platform} modpack to the installed version (${env[issue.pinKey]}) — it was set to auto-update on every start`,
            details: { pinKey: issue.pinKey, pin: env[issue.pinKey] },
          });
          pinned += 1;
        }
      } else if (anyUnresolved) {
        await this.db
          .update(servers)
          .set({ packPinNeedsReview: true })
          .where(eq(servers.id, server.id));
        flagged += 1;
      }
    }

    return { pinned, flagged };
  }
}
