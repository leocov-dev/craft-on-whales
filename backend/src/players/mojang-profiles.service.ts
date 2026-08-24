import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { apiCache } from '../db/schema';

const CACHE_PREFIX = 'mojang-profile:';
const TTL_MS = 24 * 60 * 60 * 1000;

export interface MojangProfile {
  uuid: string | null;
  name: string;
}

/** Convert Mojang's undashed UUID form to the dashed form the server files use. */
export function uuidToDashed(uuid: unknown): string | null {
  const hex = String(uuid).replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Mojang username → profile (UUID) resolution, cached in SQLite so repeated
 * player actions never hammer the API. Unknown names resolve to null. Ported
 * from src/services/mojangProfiles.ts.
 *
 * `uuidToDashed` also has a scoped duplicate at
 * `backend/src/analytics/mojang-uuid.util.ts`, ported early by the Analytics
 * fork specifically because the real `MojangProfilesService` (this file)
 * didn't exist yet and `resolveProfile`'s network/cache half was out of that
 * task's scope — that duplicate is intentionally left as-is per this task's
 * directive (touching `backend/src/analytics/` was out of scope here).
 */
@Injectable()
export class MojangProfilesService {
  constructor(private readonly dbService: DbService) {}

  private get db() {
    return this.dbService.db;
  }

  /**
   * Resolve a username to { uuid (dashed), name (canonical casing) }.
   * Returns null when Mojang says the name does not exist (404).
   * Throws on network/API failure so callers can distinguish "unknown
   * player" from "lookup unavailable".
   */
  async resolveProfile(name: string): Promise<MojangProfile | null> {
    const key = CACHE_PREFIX + String(name).toLowerCase();
    const [cached] = await this.db
      .select()
      .from(apiCache)
      .where(eq(apiCache.key, key))
      .limit(1);
    if (
      cached &&
      Date.now() - Date.parse(String(cached.fetchedAt) + 'Z') < TTL_MS
    ) {
      return JSON.parse(cached.valueJson);
    }

    let profile: MojangProfile | null;
    try {
      const res = await fetch(
        'https://api.mojang.com/users/profiles/minecraft/' +
          encodeURIComponent(name),
        { signal: AbortSignal.timeout(8000) },
      );
      if (res.status === 404 || res.status === 204) {
        profile = null;
      } else if (!res.ok) {
        throw new Error(`Mojang API HTTP ${res.status}`);
      } else {
        const body = (await res.json()) as { id: string; name: string };
        profile = { uuid: uuidToDashed(body.id), name: body.name };
      }
    } catch (err) {
      if (cached) return JSON.parse(cached.valueJson); // stale beats nothing
      throw err;
    }

    await this.db
      .insert(apiCache)
      .values({ key, valueJson: JSON.stringify(profile) })
      .onConflictDoUpdate({
        target: apiCache.key,
        set: {
          valueJson: JSON.stringify(profile),
          fetchedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
        },
      });
    return profile;
  }
}
