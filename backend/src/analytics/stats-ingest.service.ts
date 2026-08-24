import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { eq, and, desc } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { playerStatSnapshots } from '../db/schema';
import { ServerQueryService } from '../servers/server-query.service';
import { PathGuardService } from '../storage/path-guard.service';
import { WorldPropsService } from '../worlds/world-props.service';
import { uuidToDashed } from './mojang-uuid.util';
import type { CuratedStats } from './types';
import { num, sumAll, pick } from './stats.util';

const RUNNING = new Set(['running', 'starting', 'unhealthy']);
const STONE_BLOCKS = [
  'minecraft:stone',
  'minecraft:cobblestone',
  'minecraft:deepslate',
  'minecraft:cobbled_deepslate',
];

/**
 * Stats ingestion: reads the world's vanilla stat files off disk, curates
 * them into a flat shape, and snapshots changes into player_stat_snapshots
 * on a periodic timer. Ports the ingestion half of legacy's src/analytics/stats.ts.
 */
@Injectable()
export class StatsIngestService implements OnModuleInit {
  private readonly logger = new Logger(StatsIngestService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly dbService: DbService,
    private readonly pathGuard: PathGuardService,
    private readonly servers: ServerQueryService,
    private readonly worldProps: WorldPropsService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  onModuleInit(): void {
    // Fire-and-forget, matching legacy's boot-time `startStatsIngest({})` call.
    this.startStatsIngest();
  }

  /** Vanilla stats JSON -> curated flat object (stable key order for diffing). */
  private curate(
    root:
      { stats?: Record<string, Record<string, unknown>> } | null | undefined,
  ): CuratedStats {
    const stats = (root && root.stats) || {};
    const custom = stats['minecraft:custom'] || {};
    const mined = stats['minecraft:mined'] || {};
    let distanceCm = 0;
    for (const [key, value] of Object.entries(custom)) {
      if (key.endsWith('_one_cm')) distanceCm += num(value); // walk/sprint/swim/fly/boat/horse/…
    }
    return {
      playtimeTicks:
        num(custom['minecraft:play_time']) ||
        num(custom['minecraft:play_one_minute']),
      deaths: num(custom['minecraft:deaths']),
      mobKills: num(custom['minecraft:mob_kills']),
      playerKills: num(custom['minecraft:player_kills']),
      damageDealt: num(custom['minecraft:damage_dealt']),
      damageTaken: num(custom['minecraft:damage_taken']),
      jumps: num(custom['minecraft:jump']),
      distanceCm,
      blocksMinedTotal: sumAll(mined),
      stoneMined: pick(mined, STONE_BLOCKS),
      diamondsMined: pick(mined, [
        'minecraft:diamond_ore',
        'minecraft:deepslate_diamond_ore',
      ]),
      ironMined: pick(mined, [
        'minecraft:iron_ore',
        'minecraft:deepslate_iron_ore',
      ]),
      ancientDebrisMined: num(mined['minecraft:ancient_debris']),
      // Vanilla has no "blocks placed" stat; minecraft:used counts right-click
      // uses per item, which is dominated by block placements — good builder proxy.
      blocksUsedTotal: sumAll(stats['minecraft:used']),
    };
  }

  private readUsercache(serverId: string): Map<string, string> {
    const names = new Map<string, string>();
    try {
      const rows = JSON.parse(
        fs.readFileSync(
          this.pathGuard.dataPath('servers', serverId, 'usercache.json'),
          'utf8',
        ),
      ) as {
        uuid: string;
        name: string;
      }[];
      for (const row of rows) {
        const uuid = uuidToDashed(row.uuid);
        if (uuid && row.name) names.set(uuid, row.name);
      }
    } catch {
      /* no usercache yet */
    }
    return names;
  }

  /**
   * Read <server>/<level>/stats/*.json and snapshot each player whose
   * curated stats changed since the last snapshot. Returns { players, snapshots }.
   */
  async ingestStats(
    serverId: string,
  ): Promise<{ players: number; snapshots: number }> {
    const server = await this.servers.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');
    // activeLevelName honors LEVEL env AND server.properties level-name — a
    // renamed/activated world would otherwise silently stop producing stats.
    const level = this.worldProps.activeLevelName(server);
    // MC 26.x moved stat files from <world>/stats to <world>/players/stats.
    let statsDir: string;
    try {
      const modern = this.pathGuard.dataPath(
        'servers',
        serverId,
        level,
        'players',
        'stats',
      );
      const legacy = this.pathGuard.dataPath(
        'servers',
        serverId,
        level,
        'stats',
      );
      statsDir = fs.existsSync(modern) ? modern : legacy;
    } catch {
      return { players: 0, snapshots: 0 };
    }
    if (!fs.existsSync(statsDir)) return { players: 0, snapshots: 0 };

    const names = this.readUsercache(serverId);
    let players = 0;
    let snapshots = 0;
    for (const file of fs.readdirSync(statsDir)) {
      if (!file.endsWith('.json')) continue;
      const uuid = uuidToDashed(path.basename(file, '.json'));
      if (!uuid) continue;
      let curated: CuratedStats;
      try {
        curated = this.curate(
          JSON.parse(fs.readFileSync(path.join(statsDir, file), 'utf8')) as {
            stats?: Record<string, Record<string, unknown>>;
          } | null,
        );
      } catch {
        continue; // partial write / malformed file — retry next cycle
      }
      players++;
      const json = JSON.stringify(curated);
      const [latest] = await this.db
        .select({ statsJson: playerStatSnapshots.statsJson })
        .from(playerStatSnapshots)
        .where(
          and(
            eq(playerStatSnapshots.serverId, serverId),
            eq(playerStatSnapshots.uuid, uuid),
          ),
        )
        .orderBy(desc(playerStatSnapshots.id))
        .limit(1);
      if (latest && latest.statsJson === json) continue;
      await this.db.insert(playerStatSnapshots).values({
        serverId,
        uuid,
        name: names.get(uuid) || '',
        ts: new Date().toISOString(),
        statsJson: json,
      });
      snapshots++;
    }
    return { players, snapshots };
  }

  /** Periodic stat ingestion for all running servers. Returns a stop function. */
  startStatsIngest({
    intervalMs = 5 * 60 * 1000,
  }: { intervalMs?: number } = {}): () => void {
    const tick = async () => {
      for (const server of await this.servers.listServers()) {
        if (!RUNNING.has(server.status)) continue;
        try {
          await this.ingestStats(server.id);
        } catch (err) {
          this.logger.error(
            `stats ingest ${server.id} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    };
    tick().catch((err: unknown) =>
      this.logger.error(
        `stats ingest tick failed: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    this.timer = setInterval(() => {
      tick().catch((err: unknown) =>
        this.logger.error(
          `stats ingest tick failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, intervalMs);
    this.timer.unref?.();
    return () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    };
  }
}
