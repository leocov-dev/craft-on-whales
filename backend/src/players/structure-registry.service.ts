import { Injectable } from '@nestjs/common';
import { ContainerService } from '../docker/container.service';
import { rcon } from '../utils/rcon';

/**
 * Server structure registry: bundled vanilla structure list + (on running
 * modded servers) a live scan of the `worldgen/structure` tag registry via
 * `/forge tags` / `/neoforge tags`. Cached per-server with a single-flight
 * promise so concurrent callers (rapid modal opens) share one scan instead
 * of stacking RCON storms.
 *
 * Extracted out of `PlayerTeleportService` — this cache/scan logic is a
 * self-contained concern (its own TTL cache + single-flight map) that
 * `PlayerTeleportService`'s teleport-mode methods only ever *read*.
 */
@Injectable()
export class StructureRegistryService {
  private readonly structureCache = new Map<
    string,
    { at: number; structures: { id: string; dimension: string }[] }
  >();
  private readonly inflight = new Map<
    string,
    Promise<{ id: string; dimension: string }[]>
  >();
  private readonly CACHE_MS = 60 * 60 * 1000;

  // Home dimension per structure — `locate` must run IN it and the teleport
  // carries the player across (a Village is Overworld even if you ask from the End).
  private readonly STRUCTURE_DIMENSION = new Map<string, string>([
    ['minecraft:fortress', 'minecraft:the_nether'],
    ['minecraft:nether_fortress', 'minecraft:the_nether'],
    ['minecraft:bastion_remnant', 'minecraft:the_nether'],
    ['minecraft:nether_fossil', 'minecraft:the_nether'],
    ['minecraft:end_city', 'minecraft:the_end'],
  ]);

  // Bundled vanilla structures + wildcard tags (usable as #tag in /locate).
  private readonly VANILLA_STRUCTURES = [
    '#minecraft:village',
    'minecraft:village_plains',
    'minecraft:village_desert',
    'minecraft:village_savanna',
    'minecraft:village_snowy',
    'minecraft:village_taiga',
    'minecraft:ancient_city',
    'minecraft:stronghold',
    'minecraft:mineshaft',
    'minecraft:trial_chambers',
    'minecraft:trail_ruins',
    'minecraft:pillager_outpost',
    'minecraft:woodland_mansion',
    'minecraft:jungle_pyramid',
    'minecraft:desert_pyramid',
    'minecraft:igloo',
    'minecraft:swamp_hut',
    'minecraft:shipwreck',
    'minecraft:ocean_monument',
    'minecraft:buried_treasure',
    '#minecraft:ruined_portal',
    'minecraft:fortress',
    'minecraft:bastion_remnant',
    'minecraft:end_city',
  ];

  constructor(private readonly containers: ContainerService) {}

  /** Best-effort home dimension for a structure id/#tag (defaults to Overworld). */
  structureDim(ref: unknown): string {
    const id = (typeof ref === 'string' ? ref : '').replace(/^#/, '');
    if (this.STRUCTURE_DIMENSION.has(id))
      return this.STRUCTURE_DIMENSION.get(id)!;
    const short = id.split(':').pop() || '';
    if (/(^|_)(nether|bastion|fortress|fossil)($|_)/.test(short))
      return 'minecraft:the_nether';
    if (/(^|_)end($|_)|end_city/.test(short)) return 'minecraft:the_end';
    return 'minecraft:overworld';
  }

  /** Structure options: server registry tags (usable as #tag) + bundled vanilla list. */
  async getServerStructures(
    serverId: string,
    { running = false }: { running?: boolean } = {},
  ): Promise<{ id: string; dimension: string }[]> {
    const cached = this.structureCache.get(serverId);
    if (cached && Date.now() - cached.at < this.CACHE_MS)
      return cached.structures;
    const key = `structures:${serverId}`;
    if (this.inflight.has(key)) return this.inflight.get(key)!;
    const promise = this.scanServerStructures(serverId, running).finally(() =>
      this.inflight.delete(key),
    );
    this.inflight.set(key, promise);
    return promise;
  }

  private async scanServerStructures(
    serverId: string,
    running: boolean,
  ): Promise<{ id: string; dimension: string }[]> {
    let structures = [...this.VANILLA_STRUCTURES];
    if (running) {
      for (const prefix of ['neoforge', 'forge']) {
        try {
          const tags: string[] = [];
          let page = 1;
          let totalPages = 1;
          do {
            const out = await rcon(this.containers, serverId, [
              prefix,
              'tags',
              'worldgen/structure',
              'list',
              String(page),
            ]);
            const pm = /<page (\d+) \/ (\d+)>/.exec(out);
            totalPages = pm?.[2] ? Number(pm[2]) : 1;
            for (const m of out.matchAll(
              /^\s*-\s*([a-z0-9_.-]+:[a-z0-9_/.-]+)\s*$/gim,
            ))
              tags.push(`#${m[1]}`);
            page += 1;
          } while (page <= totalPages && page <= 20);
          if (tags.length) {
            // Registries are full of internal plumbing tags (blacklists,
            // placement filters…) that aren't destinations — drop them, and
            // list the familiar vanilla names before the modded tags.
            const useful = tags.filter(
              (t) =>
                !/(blacklist|whitelist|filter|avoid|exclusion|cannot|_on_|has_structure)/.test(
                  t,
                ),
            );
            structures = [
              ...new Set([...this.VANILLA_STRUCTURES, ...useful.sort()]),
            ];
            break;
          }
        } catch {
          /* command unavailable */
        }
      }
    }
    const annotated = structures.map((id) => ({
      id,
      dimension: this.structureDim(id),
    }));
    this.structureCache.set(serverId, {
      at: Date.now(),
      structures: annotated,
    });
    return annotated;
  }
}
