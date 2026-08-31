import { Injectable } from '@nestjs/common';
import { ContainerService } from '../docker/container.service';
import { rcon } from '../utils/rcon';
import { biomes as VANILLA_BIOMES } from './biomes';

/**
 * Server biome registry: bundled vanilla biome list + (on running modded
 * servers) a live scan of the `worldgen/biome` dimension tags via
 * `/forge tags` / `/neoforge tags`. Cached per-server with a single-flight
 * promise so concurrent callers share one scan.
 *
 * Extracted out of `PlayerTeleportService` — same rationale as
 * `StructureRegistryService`: self-contained cache/scan logic that
 * `PlayerTeleportService`'s `tpToBiome` only ever *reads*.
 */
@Injectable()
export class BiomeRegistryService {
  private readonly biomeCache = new Map<
    string,
    {
      at: number;
      biomes: { id: string; dimension: string }[];
      byId: Map<string, string[]>;
    }
  >();
  private readonly inflight = new Map<
    string,
    Promise<{
      at: number;
      biomes: { id: string; dimension: string }[];
      byId: Map<string, string[]>;
    }>
  >();
  private readonly CACHE_MS = 60 * 60 * 1000;

  // Biomes that only exist outside the Overworld — locate must run IN their
  // home dimension, and the teleport carries the player across.
  private readonly BIOME_DIMENSION = new Map<string, string>([
    ['minecraft:the_end', 'minecraft:the_end'],
    ['minecraft:end_highlands', 'minecraft:the_end'],
    ['minecraft:end_midlands', 'minecraft:the_end'],
    ['minecraft:end_barrens', 'minecraft:the_end'],
    ['minecraft:small_end_islands', 'minecraft:the_end'],
    ['minecraft:nether_wastes', 'minecraft:the_nether'],
    ['minecraft:crimson_forest', 'minecraft:the_nether'],
    ['minecraft:warped_forest', 'minecraft:the_nether'],
    ['minecraft:soul_sand_valley', 'minecraft:the_nether'],
    ['minecraft:basalt_deltas', 'minecraft:the_nether'],
  ]);

  private readonly DIM_TAGS: [string, string][] = [
    ['minecraft:is_overworld', 'minecraft:overworld'],
    ['minecraft:is_nether', 'minecraft:the_nether'],
    ['minecraft:is_end', 'minecraft:the_end'],
  ];

  constructor(private readonly containers: ContainerService) {}

  private async fetchTagElements(
    serverId: string,
    prefix: string,
    tag: string,
  ): Promise<string[]> {
    const ids: string[] = [];
    let page = 1;
    let totalPages = 1;
    do {
      const out = await rcon(this.containers, serverId, [
        prefix,
        'tags',
        'worldgen/biome',
        'get',
        tag,
        String(page),
      ]);
      const pm = /<page (\d+) \/ (\d+)>/.exec(out);
      totalPages = pm?.[2] ? Number(pm[2]) : 1;
      for (const m of out.matchAll(
        /^\s*-\s*([a-z0-9_.-]+:[a-z0-9_/.-]+)\s*$/gim,
      ))
        ids.push(m[1]!);
      page += 1;
    } while (page <= totalPages && page <= 40);
    return ids;
  }

  /** Server-derived biome registry (mods add biomes the bundled list can't know). */
  async getServerBiomes(
    serverId: string,
    { running = false }: { running?: boolean } = {},
  ): Promise<{
    at: number;
    biomes: { id: string; dimension: string }[];
    byId: Map<string, string[]>;
  }> {
    const cached = this.biomeCache.get(serverId);
    if (cached && Date.now() - cached.at < this.CACHE_MS) return cached;
    const key = `biomes:${serverId}`;
    if (this.inflight.has(key)) return this.inflight.get(key)!;
    const promise = this.scanServerBiomes(serverId, running).finally(() =>
      this.inflight.delete(key),
    );
    this.inflight.set(key, promise);
    return promise;
  }

  private async scanServerBiomes(
    serverId: string,
    running: boolean,
  ): Promise<{
    at: number;
    biomes: { id: string; dimension: string }[];
    byId: Map<string, string[]>;
  }> {
    let biomes: { id: string; dimension: string }[] | null = null;
    if (running) {
      for (const prefix of ['neoforge', 'forge']) {
        try {
          const collected: { id: string; dimension: string }[] = [];
          for (const [tag, dimension] of this.DIM_TAGS) {
            const ids = await this.fetchTagElements(serverId, prefix, tag);
            for (const id of ids) collected.push({ id, dimension });
          }
          if (collected.length > 10) {
            biomes = collected;
            break;
          }
        } catch {
          /* command unavailable on this loader */
        }
      }
    }
    if (!biomes) {
      // Fallback: bundled vanilla registry.
      biomes = VANILLA_BIOMES.map((id) => ({
        id,
        dimension: this.BIOME_DIMENSION.get(id) || 'minecraft:overworld',
      }));
    }
    // A biome can belong to several dimension tags — keep them all so the
    // teleport can prefer the dimension the player is already standing in.
    const byId = new Map<string, string[]>();
    for (const b of biomes) {
      const dims = byId.get(b.id) || [];
      if (b.dimension && !dims.includes(b.dimension)) dims.push(b.dimension);
      byId.set(b.id, dims);
    }
    const entry = { at: Date.now(), biomes, byId };
    this.biomeCache.set(serverId, entry);
    return entry;
  }

  /** Dimensions a biome generates in: server registry first, static vanilla fallback. */
  biomeDims(serverId: string, biomeId: string): string[] {
    const cached = this.biomeCache.get(serverId);
    const dims = cached && cached.byId.get(biomeId);
    if (dims && dims.length) return dims;
    const single = this.BIOME_DIMENSION.get(biomeId);
    return single ? [single] : [];
  }
}
