import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { apiCache } from '../db/schema';

/**
 * Thin read/write wrapper over the shared `api_cache` table, factored out
 * since ModrinthApiService/CurseforgeApiService/GtnhApiService/
 * LoaderVersionsService all need identical get/set semantics but differ in
 * fetch/error handling (rate-limit codes, auth, stale-on-network-failure) —
 * that part stays in each service.
 */
@Injectable()
export class ApiCacheService {
  constructor(private readonly dbService: DbService) {}

  private get db() {
    return this.dbService.db;
  }

  /** Cached value + age, or null if no row exists. */
  get(key: string): { value: unknown; ageMs: number } | null {
    const row = this.db.select().from(apiCache).where(eq(apiCache.key, key)).get();
    if (!row) return null;
    const ageMs = Date.now() - Date.parse(row.fetchedAt.replace(' ', 'T') + 'Z');
    return { value: JSON.parse(row.valueJson), ageMs };
  }

  set(key: string, value: unknown): void {
    const valueJson = JSON.stringify(value);
    this.db
      .insert(apiCache)
      .values({ key, valueJson })
      .onConflictDoUpdate({
        target: apiCache.key,
        set: { valueJson, fetchedAt: new Date().toISOString().slice(0, 19).replace('T', ' ') },
      })
      .run();
  }
}
