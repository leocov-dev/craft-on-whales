import { Injectable } from '@nestjs/common';
import { and, isNotNull, like, lt, not } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { EventsService } from '../events/events.service';
import { apiCache, playerEvents, playerSessions } from '../db/schema';

/** Player timeline rows and closed sessions: enough history for the analytics tab. */
export const ANALYTICS_RETENTION_DAYS = 90;
/** A year of action history is a reasonable ceiling for a control panel. */
export const EVENT_RETENTION_DAYS = 365;
/** Mostly short-TTL platform responses that fall out of use but never got cleaned. */
export const API_CACHE_RETENTION_DAYS = 30;
/**
 * `api_cache` keys that carry their own invalidation and live as long as the
 * thing they describe. The per-server item registry is fingerprint-validated
 * against the installed jars (see ItemRegistryService), so pruning it by age
 * would force a full jar rescan every month.
 */
const API_CACHE_KEEP_PREFIX = 'item-registry:';

export interface RetentionResult {
  playerEvents: number;
  playerSessions: number;
  events: number;
  apiCache: number;
}

/**
 * Bounds the panel DB tables that otherwise grow for as long as the panel
 * runs. Cutoffs are computed in JS and compared as strings so the same query
 * works on SQLite and Postgres (see schema/DUAL_DIALECT_NOTES.md).
 */
@Injectable()
export class RetentionService {
  constructor(
    private readonly dbService: DbService,
    private readonly events: EventsService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  async pruneAll(): Promise<RetentionResult> {
    return {
      ...(await this.pruneAnalytics(ANALYTICS_RETENTION_DAYS)),
      events: (await this.events.pruneEvents(EVENT_RETENTION_DAYS)).removed,
      apiCache: await this.pruneApiCache(API_CACHE_RETENTION_DAYS),
    };
  }

  /** Old timeline rows and closed sessions (open sessions are never touched). */
  async pruneAnalytics(
    days: number,
  ): Promise<{ playerEvents: number; playerSessions: number }> {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const deletedEvents = await this.db
      .delete(playerEvents)
      .where(lt(playerEvents.ts, cutoff))
      .returning({ id: playerEvents.id });
    const deletedSessions = await this.db
      .delete(playerSessions)
      .where(
        and(
          isNotNull(playerSessions.endedAt),
          lt(playerSessions.endedAt, cutoff),
        ),
      )
      .returning({ id: playerSessions.id });
    return {
      playerEvents: deletedEvents.length,
      playerSessions: deletedSessions.length,
    };
  }

  async pruneApiCache(days: number): Promise<number> {
    // `fetched_at` is 'YYYY-MM-DD HH:MM:SS' on SQLite and starts the same way
    // on Postgres, so a plain string comparison against this cutoff orders
    // correctly on both.
    const cutoff = new Date(Date.now() - days * 86_400_000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');
    const removed = await this.db
      .delete(apiCache)
      .where(
        and(
          lt(apiCache.fetchedAt, cutoff),
          not(like(apiCache.key, `${API_CACHE_KEEP_PREFIX}%`)),
        ),
      )
      .returning({ key: apiCache.key });
    return removed.length;
  }
}
