import { Injectable } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { playerStatSnapshots } from '../db/schema';
import type { CuratedStats } from './types';
import type { SnapshotRow } from './stats.util';

interface XrayPlayer {
  uuid: string;
  name: string;
  stoneMined: number;
  diamondsMined: number;
  ancientDebrisMined: number;
  diamondRatio: number;
  debrisRatio: number;
}

export interface XrayFlaggedPlayer extends XrayPlayer {
  percentile: number;
  flagged: boolean;
  reasons: string[];
}

export interface XrayReport {
  advisory: true;
  sampleSize: number;
  medianDiamondRatio: number;
  medianDebrisRatio: number;
  players: XrayFlaggedPlayer[];
  flagged: XrayFlaggedPlayer[];
}

/**
 * Advisory X-ray / anti-cheat heuristic, split out of the read-side stats
 * service since it's a self-contained statistical check over the same
 * snapshot table rather than part of profile/scoreboard assembly.
 */
@Injectable()
export class StatsXrayService {
  constructor(private readonly dbService: DbService) {}

  private get db() {
    return this.dbService.db;
  }

  private async latestSnapshot(
    serverId: string,
    uuid: string,
  ): Promise<SnapshotRow | undefined> {
    const [row] = await this.db
      .select()
      .from(playerStatSnapshots)
      .where(
        and(
          eq(playerStatSnapshots.serverId, serverId),
          eq(playerStatSnapshots.uuid, uuid),
        ),
      )
      .orderBy(desc(playerStatSnapshots.id))
      .limit(1);
    return row;
  }

  private median(values: number[]): number {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const midVal = sorted[mid] ?? 0;
    return sorted.length % 2 ? midVal : ((sorted[mid - 1] ?? 0) + midVal) / 2;
  }

  /**
   * Advisory X-ray heuristic: each player's diamond/(stone+1) and
   * ancient-debris ratios vs the server median (players with >= 64 stone
   * mined). Flags ratios over 4x median with at least 16 diamonds —
   * evidence only, never punitive.
   */
  async xrayReport(serverId: string): Promise<XrayReport> {
    const uuids = await this.db
      .selectDistinct({ uuid: playerStatSnapshots.uuid })
      .from(playerStatSnapshots)
      .where(eq(playerStatSnapshots.serverId, serverId));
    const playersRaw = await Promise.all(
      uuids.map(async ({ uuid }): Promise<XrayPlayer | null> => {
        const latest = await this.latestSnapshot(serverId, uuid);
        if (!latest) return null;
        const s = JSON.parse(latest.statsJson) as CuratedStats;
        return {
          uuid,
          name: latest.name || uuid.slice(0, 8),
          stoneMined: s.stoneMined,
          diamondsMined: s.diamondsMined,
          ancientDebrisMined: s.ancientDebrisMined,
          diamondRatio: s.diamondsMined / (s.stoneMined + 1),
          debrisRatio: s.ancientDebrisMined / (s.stoneMined + 1),
        };
      }),
    );
    const players: XrayPlayer[] = playersRaw.filter(
      (p): p is XrayPlayer => p !== null,
    );

    const eligible = players.filter((p) => p.stoneMined >= 64);
    const medDiamond = this.median(eligible.map((p) => p.diamondRatio));
    const medDebris = this.median(eligible.map((p) => p.debrisRatio));
    // Floor keeps a lone miner on a fresh server from dividing by a zero median.
    const effDiamond = Math.max(medDiamond, 0.001);
    const effDebris = Math.max(medDebris, 0.0005);

    const ratios = players.map((p) => p.diamondRatio).sort((a, b) => a - b);
    const out: XrayFlaggedPlayer[] = players
      .map((p) => {
        const flaggedDiamond =
          p.stoneMined >= 64 &&
          p.diamondsMined >= 16 &&
          p.diamondRatio > 4 * effDiamond;
        const flaggedDebris =
          p.stoneMined >= 64 &&
          p.ancientDebrisMined >= 8 &&
          p.debrisRatio > 4 * effDebris;
        return {
          ...p,
          diamondRatio: Number(p.diamondRatio.toFixed(5)),
          debrisRatio: Number(p.debrisRatio.toFixed(5)),
          percentile:
            ratios.length > 1
              ? Math.round(
                  (ratios.filter((r) => r <= p.diamondRatio).length /
                    ratios.length) *
                    100,
                )
              : 100,
          flagged: flaggedDiamond || flaggedDebris,
          reasons: [
            ...(flaggedDiamond
              ? [
                  `diamond ratio ${(p.diamondRatio / effDiamond).toFixed(1)}x server median`,
                ]
              : []),
            ...(flaggedDebris
              ? [
                  `ancient debris ratio ${(p.debrisRatio / effDebris).toFixed(1)}x server median`,
                ]
              : []),
          ],
        };
      })
      .sort((a, b) => b.diamondRatio - a.diamondRatio);

    return {
      advisory: true,
      sampleSize: eligible.length,
      medianDiamondRatio: Number(medDiamond.toFixed(5)),
      medianDebrisRatio: Number(medDebris.toFixed(5)),
      players: out,
      flagged: out.filter((p) => p.flagged),
    };
  }
}
