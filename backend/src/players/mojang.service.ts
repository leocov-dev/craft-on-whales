import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { apiCache } from '../db/schema';
import type { MojangVersionEntry } from '../../../shared/types/wizard';

export type { MojangVersionEntry };

const MANIFEST_URL =
  'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';
const CACHE_KEY = 'mojang-version-manifest';
const TTL_MS = 6 * 60 * 60 * 1000;

export interface MojangManifest {
  latest: { release: string; snapshot: string };
  versions: MojangVersionEntry[];
}

/**
 * Mojang version manifest, cached in SQLite for 6 hours so the wizard's
 * version picker is instant and works briefly offline. Ported from
 * src/services/mojang.ts.
 */
@Injectable()
export class MojangService {
  constructor(private readonly dbService: DbService) {}

  private get db() {
    return this.dbService.db;
  }

  async getVersionManifest(): Promise<MojangManifest> {
    const [cached] = await this.db
      .select()
      .from(apiCache)
      .where(eq(apiCache.key, CACHE_KEY))
      .limit(1);
    // SQLite datetime('now') is space-separated ('2026-07-14 03:00:00'); normalize
    // to ISO 8601 before parsing (matches how the rest of the code reads timestamps).
    if (
      cached &&
      Date.now() -
        Date.parse(String(cached.fetchedAt).replace(' ', 'T') + 'Z') <
        TTL_MS
    ) {
      return JSON.parse(cached.valueJson);
    }
    try {
      const res = await fetch(MANIFEST_URL, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
      const manifest = (await res.json()) as {
        latest: MojangManifest['latest'];
        versions: MojangVersionEntry[];
      };
      const slim: MojangManifest = {
        latest: manifest.latest,
        versions: manifest.versions.map((v) => ({
          id: v.id,
          type: v.type,
          releaseTime: v.releaseTime,
        })),
      };
      await this.db
        .insert(apiCache)
        .values({ key: CACHE_KEY, valueJson: JSON.stringify(slim) })
        .onConflictDoUpdate({
          target: apiCache.key,
          set: {
            valueJson: JSON.stringify(slim),
            fetchedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
          },
        });
      return slim;
    } catch (err) {
      if (cached) return JSON.parse(cached.valueJson); // stale beats nothing
      throw err;
    }
  }

  /**
   * Version list, newest first, for pickers. By default releases only.
   *   includeSnapshots → also include the 'snapshot' channel.
   *   includeAll       → every channel Mojang publishes: release, snapshot,
   *                      old_beta and old_alpha (for "all versions incl. alphas").
   * Each entry keeps its {id, type, releaseTime} so callers can label channels.
   */
  async listVersions({
    includeSnapshots = false,
    includeAll = false,
    limit = 200,
  }: {
    includeSnapshots?: boolean;
    includeAll?: boolean;
    limit?: number;
  } = {}): Promise<MojangVersionEntry[]> {
    const manifest = await this.getVersionManifest();
    return manifest.versions
      .filter((v) =>
        includeAll
          ? true
          : v.type === 'release' || (includeSnapshots && v.type === 'snapshot'),
      )
      .slice(0, limit);
  }
}
