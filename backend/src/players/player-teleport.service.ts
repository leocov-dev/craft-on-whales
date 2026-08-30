import {
  BadRequestException,
  forwardRef,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventsService } from '../events/events.service';
import { ContainerService } from '../docker/container.service';
import { PLAYER_NAME_RE } from '../utils/player-name';
import { rcon } from '../utils/rcon';
import { PlayerRosterService } from './player-roster.service';
import { StructureRegistryService } from './structure-registry.service';
import { BiomeRegistryService } from './biome-registry.service';
// `import type` — InventoryService is the other half of the
// InventoryModule<->PlayersModule cycle (this service needs
// InventoryService.readPlayerData via getPlayerSavedPos; InventoryService
// needs PlayerRosterService.listOnlineNames). Runtime class reference via
// lazy require() in the @Inject/forwardRef below, matching the established
// pattern in servers/server-lifecycle.service.ts <-> scheduler/scheduler.service.ts.
import type { InventoryService } from '../inventory/inventory.service';

interface RunOptions {
  running?: boolean;
  actor?: string;
}

const DIMENSIONS = new Set<string>([
  'minecraft:overworld',
  'minecraft:the_nether',
  'minecraft:the_end',
]);
const DIMENSION_NAMES: Record<string, string> = {
  'minecraft:overworld': 'the Overworld',
  'minecraft:the_nether': 'the Nether',
  'minecraft:the_end': 'the End',
};

/** "minecraft:the_nether" -> "the Nether" (friendly label for messages). */
function prettyDimension(dim: string | null | undefined): string {
  return (
    DIMENSION_NAMES[dim || ''] ||
    String(dim || '')
      .split(':')
      .pop()
      ?.replace(/_/g, ' ') ||
    'this dimension'
  );
}

/**
 * Player teleports, biome/structure locating, and RCON position reads.
 * RCON-only by nature — there is no safe offline equivalent. Ported from
 * the teleport/biome/structure section of src/services/players.ts.
 *
 * Structure/biome registry scanning + caching live in
 * `StructureRegistryService` / `BiomeRegistryService` — this service only
 * orchestrates the four teleport modes (coords/player/biome/structure/rtp)
 * and reads live/saved player positions.
 */
@Injectable()
export class PlayerTeleportService {
  private readonly teleportBusy = new Set<string>();
  private readonly TP_TIMEOUT_MS = 45000;

  constructor(
    private readonly events: EventsService,
    private readonly containers: ContainerService,
    private readonly roster: PlayerRosterService,
    private readonly structures: StructureRegistryService,
    private readonly biomeRegistry: BiomeRegistryService,
    @Inject(
      forwardRef(
        // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
        () => require('../inventory/inventory.service').InventoryService,
      ),
    )
    private readonly inventory: InventoryService,
  ) {}

  private assertName(name: unknown): string {
    if (!PLAYER_NAME_RE.test(String(name))) {
      throw new BadRequestException(
        'Invalid player name (letters, digits and _ only, max 16 chars — a leading . or * for Bedrock players is fine)',
      );
    }
    return String(name);
  }

  private assertRunning(running: boolean, what: string): void {
    if (!running)
      throw new BadRequestException(`Server must be running to ${what}`);
  }

  // ---------------------------------------------------------------------- live position

  /**
   * Player's live position + dimension. Can't use `data get entity` — on
   * modded servers a broken player-NBT writer makes it throw ("An unexpected
   * error occurred") for every player. Instead we summon an invisible marker
   * AT the player (a marker's NBT always serializes), read the marker's Pos,
   * and detect the dimension via the dimension-scoped `kill` (which also
   * cleans the marker up).
   */
  async getPlayerPosition(
    serverId: string,
    player: string,
  ): Promise<{ x: number; y: number; z: number; dimension: string }> {
    this.assertName(player);
    const ALL_DIMENSIONS = [
      'minecraft:overworld',
      'minecraft:the_nether',
      'minecraft:the_end',
    ];
    const POS_RE =
      /\[\s*(-?\d+(?:\.\d+)?)[dfb]?\s*,\s*(-?\d+(?:\.\d+)?)[dfb]?\s*,\s*(-?\d+(?:\.\d+)?)[dfb]?\s*\]/;
    const tag = `cd_pos_${Math.random().toString(36).slice(2, 10)}`;
    try {
      const summon = await rcon(this.containers, serverId, [
        'execute',
        'at',
        player,
        'run',
        'summon',
        'minecraft:marker',
        '~',
        '~',
        '~',
        `{Tags:["${tag}"]}`,
      ]);
      // No "Summoned …" line means `execute at <player>` matched nothing → offline
      // (an offline player also produces empty output, so check positively).
      if (!/Summoned/i.test(summon)) {
        throw new NotFoundException('That player is not online right now.');
      }
      const posOut = await rcon(this.containers, serverId, [
        'data',
        'get',
        'entity',
        `@e[type=minecraft:marker,tag=${tag},limit=1]`,
        'Pos',
      ]);
      const pm = POS_RE.exec(posOut);
      if (!pm) {
        console.warn(
          `[players] couldn't read position for ${player} on ${serverId}: ${posOut.slice(0, 160)}`,
        );
        throw new BadRequestException(
          "Couldn't read the player's position from the server.",
        );
      }
      // Whichever dimension reports "Killed" is where the player is — and this
      // removes the marker at the same time. Run all three so nothing is left behind.
      let dimension: string | null = null;
      for (const dim of ALL_DIMENSIONS) {
        const k = await rcon(this.containers, serverId, [
          'execute',
          'in',
          dim,
          'run',
          'kill',
          `@e[type=minecraft:marker,tag=${tag}]`,
        ]).catch(() => '');
        if (!dimension && /Killed/i.test(k)) dimension = dim;
      }
      return {
        x: Math.round(Number(pm[1]!)),
        y: Math.round(Number(pm[2]!)),
        z: Math.round(Number(pm[3]!)),
        dimension: dimension || 'minecraft:overworld',
      };
    } catch (err) {
      // Best-effort cleanup if we bailed before the kill loop.
      for (const dim of ALL_DIMENSIONS) {
        rcon(this.containers, serverId, [
          'execute',
          'in',
          dim,
          'run',
          'kill',
          `@e[type=minecraft:marker,tag=${tag}]`,
        ]).catch(() => {});
      }
      throw err;
    }
  }

  /**
   * Player's last-SAVED position + dimension, read straight from their .dat
   * on disk. A filesystem read — ZERO load on the Minecraft server thread —
   * so it's the safe way to seed a teleport search. Slightly stale (last
   * autosave), which is fine for a search centre. Returns null when there's
   * no saved data.
   */
  private async getPlayerSavedPos(
    serverId: string,
    player: string,
  ): Promise<{ x: number; z: number; dimension: string } | null> {
    try {
      const list = this.roster.listPlayers(serverId);
      const found = list.find(
        (p) => p.name.toLowerCase() === player.toLowerCase(),
      );
      if (!found || !found.uuid) return null;
      const data = await this.inventory.readPlayerData(serverId, found.uuid);
      if (!data.pos) return null;
      return {
        x: Math.round(data.pos.x),
        z: Math.round(data.pos.z),
        dimension: data.pos.dimension || 'minecraft:overworld',
      };
    } catch {
      return null;
    }
  }

  /** Run a /locate (with a generous timeout) and 404 cleanly if the id isn't registered here. */
  private async runLocate(
    serverId: string,
    prefix: string[],
    type: string,
    id: string,
  ): Promise<string> {
    const located = await rcon(
      this.containers,
      serverId,
      [...prefix, 'run', 'locate', type, id],
      { timeoutMs: this.TP_TIMEOUT_MS },
    );
    if (
      /there is no \w+ with type|isn'?t a valid|unknown \w+ type/i.test(located)
    ) {
      throw new NotFoundException(
        `"${String(id).replace(/^#/, '')}" isn't available on this server — a mod may have renamed or removed it.`,
      );
    }
    return located;
  }

  private assertTpOutput(out: string, player: string): void {
    if (/No entity was found|No player was found/i.test(out)) {
      throw new NotFoundException(
        `${player} is not online — teleport needs a live player`,
      );
    }
    if (/Unknown or incomplete command|Incorrect argument/i.test(out)) {
      throw new BadRequestException(
        `Teleport command rejected by the server: ${out}`,
      );
    }
  }

  /**
   * Land a player safely on the SURFACE at x/z: spreadplayers places its
   * target on the highest solid block, so nobody materializes mid-air.
   * Optionally run inside another dimension.
   */
  private async surfaceTeleport(
    serverId: string,
    player: string,
    x: number | string,
    z: number | string,
    dimension: string | null,
  ): Promise<string> {
    const prefix = dimension
      ? ['execute', 'in', dimension, 'run']
      : ['execute', 'at', player, 'run'];
    let out = '';
    for (const range of [1, 96, 512]) {
      // In the Nether, cap the landing height below the bedrock roof.
      const cap = dimension === 'minecraft:the_nether' ? ['under', '120'] : [];
      out = await rcon(
        this.containers,
        serverId,
        [
          ...prefix,
          'spreadplayers',
          String(x),
          String(z),
          '0',
          String(range),
          ...cap,
          'false',
          player,
        ],
        { timeoutMs: this.TP_TIMEOUT_MS },
      );
      if (/No entity was found|No player was found/i.test(out)) {
        throw new NotFoundException('That player is not online right now.');
      }
      if (!/Could not spread|error/i.test(out)) return out;
    }
    throw new BadRequestException(
      `No safe ground within 512 blocks of ${x}, ${z}${dimension ? ` in ${prettyDimension(dimension)}` : ''} (open water or void) — try different coordinates or give an explicit Y.`,
    );
  }

  // ---------------------------------------------------------------------- structures

  /**
   * Structure teleport: locate the nearest <structure> — from the player, or
   * from a RANDOM ring point for "surprise me" exploration — then land on
   * the surface beside it.
   */
  async tpToStructure(
    serverId: string,
    player: string,
    structureRef: string,
    {
      random = false,
      maxDistance = 5000,
    }: { random?: boolean; maxDistance?: number } = {},
    { running = false, actor = 'system' }: RunOptions = {},
  ): Promise<{
    player: string;
    structure: string;
    x: number;
    z: number;
    dimension: string;
    output: string;
  }> {
    this.assertName(player);
    this.assertRunning(running, 'teleport a player');
    if (!/^#?[a-z0-9_.-]+:[a-z0-9_/.-]+$/.test(String(structureRef)))
      throw new BadRequestException('Invalid structure id');

    const searchDim = this.structures.structureDim(structureRef);
    const saved = await this.getPlayerSavedPos(serverId, player);
    const sameDim = saved && saved.dimension === searchDim;
    let fromX = sameDim ? saved.x : 0;
    let fromZ = sameDim ? saved.z : 0;
    if (random) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 500 + Math.random() * Math.max(16, maxDistance - 500);
      fromX = Math.round(fromX + Math.cos(angle) * dist);
      fromZ = Math.round(fromZ + Math.sin(angle) * dist);
    }

    const located = await this.runLocate(
      serverId,
      [
        'execute',
        'in',
        searchDim,
        'positioned',
        String(fromX),
        '80',
        String(fromZ),
      ],
      'structure',
      structureRef,
    );
    if (/Could not find/i.test(located) || !located.trim()) {
      throw new NotFoundException(
        `No ${structureRef.replace(/^#/, '')} found in ${prettyDimension(searchDim)}${random ? ' — try again (each try searches a new random point)' : ''}.`,
      );
    }
    const m = /is at \[(-?\d+),\s*(~|-?\d+),\s*(-?\d+)\]/.exec(located);
    if (!m)
      throw new BadRequestException(
        `Could not parse the locate result: ${located}`,
      );
    const x = Number(m[1]);
    const z = Number(m[3]);

    const out = await this.surfaceTeleport(serverId, player, x, z, searchDim);
    this.events.recordEvent({
      serverId,
      actor,
      type: 'player-teleport',
      summary: `${player} sent to ${random ? 'a random' : 'the nearest'} ${structureRef.replace(/^#/, '')} in ${prettyDimension(searchDim)} at ${x}, ${z} (surface)`,
      details: {
        player,
        mode: 'structure',
        structure: structureRef,
        x,
        z,
        random,
        dimension: searchDim,
      },
    });
    return {
      player,
      structure: structureRef,
      x,
      z,
      dimension: searchDim,
      output: out,
    };
  }

  /**
   * Custom RTP — no mod dependency: pick a random point in the ring
   * [minDistance, maxDistance] around the player (or world origin) and land
   * on the surface via spreadplayers; ocean/void picks retry with a fresh
   * point.
   */
  async rtpPlayer(
    serverId: string,
    player: string,
    {
      minDistance: minDistanceInput = 500,
      maxDistance: maxDistanceInput = 5000,
      center = 'player',
    }: {
      minDistance?: number;
      maxDistance?: number;
      center?: 'player' | 'origin';
    } = {},
    { running = false, actor = 'system' }: RunOptions = {},
  ): Promise<{
    player: string;
    x: number;
    z: number;
    dimension: string | null;
    distance: number;
    attempts: number;
    output: string;
  }> {
    this.assertName(player);
    this.assertRunning(running, 'randomly teleport a player');
    const minDistance = Math.max(0, Math.floor(minDistanceInput));
    const maxDistance = Math.max(
      minDistance + 16,
      Math.floor(maxDistanceInput),
    );

    const saved =
      center === 'origin'
        ? null
        : await this.getPlayerSavedPos(serverId, player);
    const cx = saved ? saved.x : 0;
    const cz = saved ? saved.z : 0;
    const dim = saved ? saved.dimension : null; // explicit → nether-roof cap; null → at-player

    const ATTEMPTS = 6;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = minDistance + Math.random() * (maxDistance - minDistance);
      const x = Math.round(cx + Math.cos(angle) * dist);
      const z = Math.round(cz + Math.sin(angle) * dist);
      try {
        const out = await this.surfaceTeleport(serverId, player, x, z, dim);
        this.events.recordEvent({
          serverId,
          actor,
          type: 'player-teleport',
          summary: `${player} randomly teleported to ${x}, ${z} (surface, ${Math.round(dist)} blocks out, attempt ${attempt}/${ATTEMPTS})`,
          details: {
            player,
            mode: 'rtp',
            x,
            z,
            dimension: dim,
            distance: Math.round(dist),
            attempt,
          },
        });
        return {
          player,
          x,
          z,
          dimension: dim,
          distance: Math.round(dist),
          attempts: attempt,
          output: out,
        };
      } catch (err) {
        if ((err as { status?: number }).status === 404) throw err; // player left — stop immediately
        lastErr = err; // no safe ground here — roll a new point
      }
    }
    void lastErr;
    throw new BadRequestException(
      `Couldn't find safe ground in ${ATTEMPTS} tries (lots of ocean around?) — try a bigger max distance.`,
    );
  }

  // ---------------------------------------------------------------------- biomes

  async tpToBiome(
    serverId: string,
    player: string,
    biomeId: string,
    { running = false, actor = 'system' }: RunOptions = {},
  ): Promise<{
    player: string;
    biome: string;
    x: number;
    z: number;
    dimension: string;
    output: string;
  }> {
    this.assertName(player);
    this.assertRunning(running, 'teleport a player');
    if (!/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/.test(String(biomeId)))
      throw new BadRequestException('Invalid biome id');

    // Cross-dimension biomes must be located IN their home dimension. Warm the
    // server registry first: biomeDims only READS the cache, and after a
    // panel restart it would otherwise fall back to a tiny static list and
    // lose most home dims.
    await this.biomeRegistry
      .getServerBiomes(serverId, { running: true })
      .catch(() => {});
    const dims = this.biomeRegistry.biomeDims(serverId, String(biomeId));
    const saved = await this.getPlayerSavedPos(serverId, player);
    const playerDim = saved ? saved.dimension : null;
    const searchDim =
      playerDim && dims.includes(playerDim)
        ? playerDim
        : dims[0] || playerDim || 'minecraft:overworld';
    const sameDim = saved && searchDim === playerDim;
    const fromX = sameDim ? String(saved.x) : '0';
    const fromZ = sameDim ? String(saved.z) : '0';
    // CRITICAL: never `execute as <player>` — it makes the player the command
    // sender, so the locate result goes to their chat and RCON receives NOTHING.
    const located = await this.runLocate(
      serverId,
      ['execute', 'in', searchDim, 'positioned', fromX, '80', fromZ],
      'biome',
      biomeId,
    );
    if (/Could not find/i.test(located)) {
      throw new NotFoundException(
        `No ${biomeId} was found in ${prettyDimension(searchDim)}${sameDim ? ` near ${player}` : ''} — try from a different spot`,
      );
    }
    const m = /is at \[(-?\d+),\s*(~|-?\d+),\s*(-?\d+)\]/.exec(located);
    if (!m) {
      throw new BadRequestException(
        located
          ? `Could not parse the locate result: ${located}`
          : `The server returned nothing for ${biomeId} in ${searchDim} — it may not generate in this world (modded packs sometimes replace vanilla biomes).`,
      );
    }
    const x = Number(m[1]);
    const z = Number(m[3]);

    const out = await this.surfaceTeleport(serverId, player, x, z, searchDim);
    this.events.recordEvent({
      serverId,
      actor,
      type: 'player-teleport',
      summary: `${player} teleported to nearest ${biomeId} (${x}, ${z}, surface${searchDim ? `, ${searchDim}` : ''})`,
      details: {
        player,
        mode: 'biome',
        biome: biomeId,
        x,
        z,
        surface: true,
        dimension: searchDim,
      },
    });
    return { player, biome: biomeId, x, z, dimension: searchDim, output: out };
  }

  // ---------------------------------------------------------------------- coords / player

  async tpToCoords(
    serverId: string,
    player: string,
    {
      x,
      y,
      z,
      dimension,
      safe = true,
    }: {
      x: number | string;
      y?: number | string | null;
      z: number | string;
      dimension?: string | null;
      safe?: boolean;
    },
    { running = false, actor = 'system' }: RunOptions = {},
  ): Promise<{
    player: string;
    x: number;
    y: number | 'surface';
    z: number;
    dimension: string | null;
    output: string;
  }> {
    this.assertName(player);
    this.assertRunning(running, 'teleport a player');
    const hasY = y !== undefined && y !== null && String(y).trim() !== '';
    for (const v of hasY ? [x, y, z] : [x, z]) {
      if (!Number.isFinite(Number(v)))
        throw new BadRequestException('Coordinates must be numbers');
    }
    if (dimension && !DIMENSIONS.has(dimension))
      throw new BadRequestException('Unknown dimension');

    let out: string;
    const landedY: number | 'surface' = hasY ? Number(y) : 'surface';
    if (!hasY) {
      // No Y given → snap to the surface instead of guessing an altitude.
      out = await this.surfaceTeleport(
        serverId,
        player,
        x,
        z,
        dimension || null,
      );
    } else {
      if (safe) {
        // Fatal-fall insurance for explicit altitudes: 15s of slow falling.
        await rcon(this.containers, serverId, [
          'effect',
          'give',
          player,
          'minecraft:slow_falling',
          '15',
          '0',
          'true',
        ]).catch(() => {});
      }
      const args = dimension
        ? [
            'execute',
            'in',
            dimension,
            'run',
            'tp',
            player,
            String(x),
            String(y),
            String(z),
          ]
        : ['tp', player, String(x), String(y), String(z)];
      out = await rcon(this.containers, serverId, args);
      this.assertTpOutput(out, player);
    }

    const where = `${x} ${landedY} ${z}${dimension ? ` in ${dimension}` : ''}`;
    this.events.recordEvent({
      serverId,
      actor,
      type: 'player-teleport',
      summary: `${player} teleported to ${where}${!hasY ? ' (surface)' : safe ? ' (soft landing)' : ''}`,
      details: {
        player,
        mode: 'coords',
        x: Number(x),
        y: hasY ? Number(y) : null,
        z: Number(z),
        dimension: dimension || null,
        surface: !hasY,
        safe,
      },
    });
    return {
      player,
      x: Number(x),
      y: landedY,
      z: Number(z),
      dimension: dimension || null,
      output: out,
    };
  }

  async tpToPlayer(
    serverId: string,
    player: string,
    target: string,
    { running = false, actor = 'system' }: RunOptions = {},
  ): Promise<{ player: string; target: string; output: string }> {
    this.assertName(player);
    this.assertName(target);
    this.assertRunning(running, 'teleport a player');
    const out = await rcon(this.containers, serverId, ['tp', player, target]);
    this.assertTpOutput(out, player);
    this.events.recordEvent({
      serverId,
      actor,
      type: 'player-teleport',
      summary: `${player} teleported to ${target}`,
      details: { player, mode: 'player', target },
    });
    return { player, target, output: out };
  }

  // ---------------------------------------------------------------------- teleport concurrency guard

  // /locate runs on the server's main thread and can stall it for seconds —
  // firing several concurrently freezes the tick loop long enough to TIME
  // OUT every online player. One teleport at a time per server; extras get a 429.
  async withTeleportSlot<T>(
    serverId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (this.teleportBusy.has(serverId)) {
      throw new HttpException(
        'A teleport is already searching on this server — give it a second and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.teleportBusy.add(serverId);
    try {
      return await fn();
    } finally {
      this.teleportBusy.delete(serverId);
    }
  }
}
