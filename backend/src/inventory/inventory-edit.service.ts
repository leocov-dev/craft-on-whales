import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ContainerService } from '../docker/container.service';
import { EventsService } from '../events/events.service';
import {
  PLAYER_ROSTER_CONTRACT,
  type PlayerRosterContract,
} from './player-roster.contract';
import { rcon } from '../utils/rcon';
import { PlayerDataFileService } from './player-data-file.service';
import { assertUuid, assertItemId } from './nbt-codec';
import {
  resolveSlot,
  clampCount,
  makeRawItem,
  rawItemList,
  applyOfflineSlotEdit,
  applyOfflineMove,
  applyOfflineNestedEdit,
  type SlotSpec,
  type SlotEditResult,
  type MoveResult,
} from './inventory-slots.util';

// Same reasoning as inventory.service.ts: this file reads/manipulates raw
// prismarine-nbt trees — genuinely dynamic data.
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

const RUNNING_STATES = new Set(['running', 'unhealthy']); // rcon answers while unhealthy

export interface GiveResult {
  player: string;
  item: string;
  count: number;
  output: string;
}

export interface ClearResult {
  player: string;
  item: string | null;
  output: string;
  nothingRemoved: boolean;
}

export interface EditContext {
  uuid: string;
  name: string | null;
  running: boolean;
  online: boolean;
  onlineKnown: boolean;
  mechanism: 'rcon' | 'file';
}

export interface EditSlotResult extends SlotEditResult {
  player: string;
  mechanism: 'rcon' | 'file';
  slot: string;
}

export interface MoveItemResult extends MoveResult {
  player: string;
  mechanism: 'rcon' | 'file';
  from: string;
  to: string;
}

export interface AddItemResult {
  player: string;
  item: string;
  count: number;
  slot: number;
  mechanism: 'rcon' | 'file';
  output?: string;
}

/**
 * RCON give/clear plus RCON-vs-file "god mode" slot editing (set/delete/
 * count/move/add), auto-picking its mechanism: RCON `item replace entity`
 * while the player is online, direct .dat rewrites (via
 * PlayerDataFileService) while they are not. Extracted from InventoryService
 * (see `.plan/reviews/05-inventory-blueprints-items.md`, "InventoryService
 * is a God class").
 *
 * Genuine bidirectional cycle with PlayersModule: `editContext` needs
 * `PlayerRosterService.listOnlineNames` (to pick the RCON-vs-file
 * mechanism) — injected via the `PLAYER_ROSTER_CONTRACT` token
 * (`./player-roster.contract.ts`) rather than a direct forwardRef()+
 * require() on the class itself; InventoryModule still needs one
 * module-level `forwardRef(() => PlayersModule)` since the cycle itself is
 * genuine, but this class no longer does.
 */
@Injectable()
export class InventoryEditService {
  constructor(
    private readonly events: EventsService,
    private readonly containers: ContainerService,
    private readonly playerDataFiles: PlayerDataFileService,
    @Inject(PLAYER_ROSTER_CONTRACT)
    private readonly players: PlayerRosterContract,
  ) {}

  // -------------------------------------------------------------- RCON give/clear

  private async assertRunning(serverId: string, what: string): Promise<void> {
    let info: Awaited<ReturnType<ContainerService['inspectStatus']>>;
    try {
      info = await this.containers.inspectStatus(serverId);
    } catch {
      throw new ServiceUnavailableException(
        `Docker is not reachable — cannot ${what}`,
      );
    }
    if (!info.exists || !RUNNING_STATES.has(info.status)) {
      throw new BadRequestException(
        `The server must be running to ${what} — item edits on stopped servers are out of scope (offline data is read-only)`,
      );
    }
  }

  /** Surface the server's own error text on command failures. */
  private assertRconOk(out: string, playerName: string): void {
    if (/No player was found|No entity was found/i.test(out))
      throw new NotFoundException(out || `${playerName} is not online`);
    if (
      /Unknown item|Unknown slot|Unknown or incomplete command|Incorrect argument|Expected |The target inventory/i.test(
        out,
      )
    ) {
      throw new BadRequestException(`The server rejected the command: ${out}`);
    }
  }

  /** `/give <player> <item> <count>` via RCON. */
  async giveItem(
    serverId: string,
    playerName: string,
    itemId: string,
    count: number = 1,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<GiveResult> {
    const item = assertItemId(itemId);
    const n = Math.min(6400, Math.max(1, Math.trunc(Number(count) || 1)));
    await this.assertRunning(serverId, 'give items');
    const out = await rcon(this.containers, serverId, [
      'give',
      playerName,
      item,
      n,
    ]);
    this.assertRconOk(out, playerName);
    this.events.recordEvent({
      serverId,
      actor,
      type: 'player-give',
      summary: `Gave ${playerName} ${n} × ${item}`,
      details: { player: playerName, item, count: n, output: out },
    });
    return { player: playerName, item, count: n, output: out };
  }

  /** `/clear <player> [item]` via RCON (no item = clear everything). */
  async clearItem(
    serverId: string,
    playerName: string,
    itemId: string | null = null,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<ClearResult> {
    const item = itemId ? assertItemId(itemId) : null;
    await this.assertRunning(serverId, 'clear items');
    const out = await rcon(
      this.containers,
      serverId,
      item ? ['clear', playerName, item] : ['clear', playerName],
    );
    this.assertRconOk(out, playerName);
    const nothing = /No items were found/i.test(out);
    this.events.recordEvent({
      serverId,
      actor,
      type: 'player-clear',
      summary: item
        ? `Cleared ${item} from ${playerName}`
        : `Cleared the entire inventory of ${playerName}`,
      details: {
        player: playerName,
        item,
        output: out,
        nothingRemoved: nothing,
      },
    });
    return { player: playerName, item, output: out, nothingRemoved: nothing };
  }

  // -------------------------------------------------------------- god-mode edit context

  /** Who/where/how for an edit: player name, server state, chosen mechanism. */
  async editContext(serverId: string, uuidInput: string): Promise<EditContext> {
    const uuid = assertUuid(uuidInput);
    const { byUuid } = this.playerDataFiles.usercacheMaps(serverId);
    const name = byUuid.get(uuid) || null;
    let running = false;
    try {
      const info = await this.containers.inspectStatus(serverId);
      running = info.exists && RUNNING_STATES.has(info.status);
    } catch {
      /* docker down — file edits still possible */
    }
    let online = false;
    let onlineKnown = true;
    if (running && name) {
      try {
        const names = await this.players.listOnlineNames(serverId, {
          throwOnError: true,
        });
        online = names.some((n) => n.toLowerCase() === name.toLowerCase());
      } catch {
        // RCON hiccup: we do NOT know whether they're online. Mark it so withDatFile
        // refuses the offline file path rather than assuming offline and clobbering a live save.
        onlineKnown = false;
      }
    }
    return {
      uuid,
      name,
      running,
      online,
      onlineKnown,
      mechanism: running && online ? 'rcon' : 'file',
    };
  }

  // --------------------------------------------------------------- online path

  /**
   * `save-all flush` — forces the server to rewrite every online player's
   * .dat with their LIVE state. Best-effort; the short wait lets the write
   * land.
   */
  async flushPlayerData(serverId: string): Promise<boolean> {
    try {
      await rcon(this.containers, serverId, ['save-all', 'flush']);
      await new Promise((r) => setTimeout(r, 1200));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read one live slot. Primary: `data get entity` (console sender → RCON
   * sees the output). Fallback: NeoForge 26.x can fail ANY
   * `data get entity <player>` with "An unexpected error occurred" while the
   * player is online — in that case flush the live state to disk with
   * `save-all flush` and read the freshly written .dat instead.
   */
  private async readSlotOnline(
    serverId: string,
    ctx: EditContext,
    spec: SlotSpec,
  ): Promise<{
    exists: boolean;
    id?: string | null;
    count?: number;
    hasComponents?: boolean;
  }> {
    const nbtPath =
      spec.kind === 'equipment'
        ? `equipment.${spec.piece}`
        : `${spec.list}[{Slot:${spec.nbtSlot}b}]`;
    const out = await rcon(this.containers, serverId, [
      'data',
      'get',
      'entity',
      ctx.name!,
      nbtPath,
    ]);
    if (/No entity was found|No player was found/i.test(out)) {
      throw new BadRequestException(
        `${ctx.name} just went offline — reload and try again (the edit will use the save file instead)`,
      );
    }
    if (/unexpected error/i.test(out)) {
      await this.flushPlayerData(serverId);
      try {
        return await this.playerDataFiles.readDatSlot(serverId, ctx.uuid, spec);
      } catch {
        throw new BadRequestException(
          'Could not read the live inventory (this server rejects data queries and its save file is unreadable) — try again',
        );
      }
    }
    if (/Found no elements|has no|Invalid|Expected/i.test(out))
      return { exists: false };
    const id = /\bid:\s*"([^"]+)"/.exec(out);
    if (!id) return { exists: false };
    const count = /\bcount:\s*(\d+)/.exec(out); // top-level count prints first in vanilla SNBT
    return {
      exists: true,
      id: id[1],
      count: count ? Number(count[1]) : 1,
      hasComponents: /\bcomponents:\s*\{/.test(out),
    };
  }

  private async editSlotOnline(
    serverId: string,
    ctx: EditContext,
    spec: SlotSpec,
    {
      op,
      item,
      count,
    }: { op: 'set' | 'delete' | 'count'; item: string | null; count: number },
  ): Promise<SlotEditResult> {
    const name = ctx.name!;
    if (op === 'delete') {
      const prev = await this.readSlotOnline(serverId, ctx, spec);
      if (!prev.exists)
        throw new NotFoundException(`${spec.rconSlot} is already empty`);
      const out = await rcon(this.containers, serverId, [
        'item',
        'replace',
        'entity',
        name,
        spec.rconSlot,
        'with',
        'minecraft:air',
      ]);
      this.assertRconOk(out, name);
      return { item: prev.id ?? null, count: prev.count ?? 0, note: null };
    }
    if (op === 'set') {
      const out = await rcon(this.containers, serverId, [
        'item',
        'replace',
        'entity',
        name,
        spec.rconSlot,
        'with',
        item!,
        count,
      ]);
      this.assertRconOk(out, name);
      return { item, count, note: null };
    }
    // op === 'count' — re-issue the same id with the new count. `item replace`
    // always creates a fresh stack, so custom components are lost; flag it.
    const cur = await this.readSlotOnline(serverId, ctx, spec);
    if (!cur.exists)
      throw new NotFoundException(
        `${spec.rconSlot} is empty — nothing to re-count`,
      );
    const out = await rcon(this.containers, serverId, [
      'item',
      'replace',
      'entity',
      name,
      spec.rconSlot,
      'with',
      cur.id!,
      count,
    ]);
    this.assertRconOk(out, name);
    return {
      item: cur.id ?? null,
      count,
      note: cur.hasComponents
        ? 'This item carried custom data (enchantments, contents, …) which a live count change resets — change counts while the player is offline to keep it.'
        : null,
    };
  }

  private async moveSlotOnline(
    serverId: string,
    ctx: EditContext,
    fromSpec: SlotSpec,
    toSpec: SlotSpec,
  ): Promise<MoveResult> {
    const name = ctx.name!;
    const src = await this.readSlotOnline(serverId, ctx, fromSpec);
    if (!src.exists)
      throw new NotFoundException(
        `${fromSpec.rconSlot} is empty — nothing to move`,
      );
    const dst = await this.readSlotOnline(serverId, ctx, toSpec);
    if (dst.exists) {
      throw new BadRequestException(
        `${toSpec.rconSlot} is occupied — live moves need an empty target. Swaps work while the player is offline (kick them first).`,
      );
    }
    // `from entity` copies the stack WITH its components, then the source is aired.
    let out = await rcon(this.containers, serverId, [
      'item',
      'replace',
      'entity',
      name,
      toSpec.rconSlot,
      'from',
      'entity',
      name,
      fromSpec.rconSlot,
    ]);
    this.assertRconOk(out, name);
    out = await rcon(this.containers, serverId, [
      'item',
      'replace',
      'entity',
      name,
      fromSpec.rconSlot,
      'with',
      'minecraft:air',
    ]);
    this.assertRconOk(out, name);
    return { item: src.id ?? null, count: src.count ?? 0, swapped: false };
  }

  // ----------------------------------------------------------- public edit API

  /**
   * Edit one slot: op 'set' (place item+count), 'delete', or 'count'.
   * `nested` = {path, index} targets a sub-inventory INSIDE the item in that
   * slot (offline mechanism only).
   */
  async editSlot(
    serverId: string,
    uuid: string,
    {
      container,
      slot,
      op,
      item = null,
      count = 1,
      nested = null,
    }: {
      container: string;
      slot: number | string;
      op: 'set' | 'delete' | 'count';
      item?: string | null;
      count?: number;
      nested?: { path: (string | number)[]; index: number } | null;
    },
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<EditSlotResult> {
    const spec = resolveSlot(container, slot);
    if (!['set', 'delete', 'count'].includes(op))
      throw new BadRequestException(`Unknown op "${op}"`);
    let resolvedItem = item;
    if (op === 'set') resolvedItem = assertItemId(item);
    const resolvedCount = clampCount(count);

    const ctx = await this.editContext(serverId, uuid);
    const playerLabel = ctx.name || ctx.uuid;
    let result: SlotEditResult;
    if (nested) {
      if (ctx.mechanism === 'rcon') {
        throw new BadRequestException(
          'Backpack contents can only be edited in the save file — stop the server or kick the player, then try again.',
        );
      }
      result = await this.playerDataFiles.withDatFile(serverId, ctx, (root) =>
        applyOfflineNestedEdit(root, spec, {
          path: nested.path,
          index: nested.index,
          op,
          item: resolvedItem,
          count: resolvedCount,
        }),
      );
    } else if (ctx.mechanism === 'rcon') {
      result = await this.editSlotOnline(serverId, ctx, spec, {
        op,
        item: resolvedItem,
        count: resolvedCount,
      });
    } else {
      result = await this.playerDataFiles.withDatFile(serverId, ctx, (root) =>
        applyOfflineSlotEdit(root, spec, {
          op,
          item: resolvedItem,
          count: resolvedCount,
        }),
      );
    }

    const where = nested
      ? `${spec.rconSlot} > ${nested.path.filter((s) => typeof s === 'string').pop() || 'contents'}[${nested.index}]`
      : spec.rconSlot;
    const summary =
      op === 'set'
        ? `${playerLabel}: ${result.count}x ${result.item} placed in ${where}`
        : op === 'delete'
          ? `${playerLabel}: ${result.item} removed from ${where}`
          : `${playerLabel}: ${result.item} in ${where} set to ${result.count}`;
    this.events.recordEvent({
      serverId,
      actor,
      type: 'inventory-edit',
      summary: `${summary} (${ctx.mechanism === 'rcon' ? 'live' : 'file edit'})`,
      details: {
        player: playerLabel,
        uuid: ctx.uuid,
        op,
        container,
        slot: spec.slot,
        nested,
        item: result.item,
        count: result.count,
        via: ctx.mechanism,
      },
    });
    return {
      ...result,
      player: playerLabel,
      mechanism: ctx.mechanism,
      slot: where,
    };
  }

  /** Move/swap between any two slots (inventory <-> ender chest included). */
  async moveItem(
    serverId: string,
    uuid: string,
    from: { container: string; slot: number | string },
    to: { container: string; slot: number | string },
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<MoveItemResult> {
    const fromSpec = resolveSlot(from.container, from.slot);
    const toSpec = resolveSlot(to.container, to.slot);
    if (fromSpec.rconSlot === toSpec.rconSlot)
      throw new BadRequestException('Source and destination are the same slot');

    const ctx = await this.editContext(serverId, uuid);
    const playerLabel = ctx.name || ctx.uuid;
    const result =
      ctx.mechanism === 'rcon'
        ? await this.moveSlotOnline(serverId, ctx, fromSpec, toSpec)
        : await this.playerDataFiles.withDatFile(serverId, ctx, (root) =>
            applyOfflineMove(root, fromSpec, toSpec),
          );

    this.events.recordEvent({
      serverId,
      actor,
      type: 'inventory-edit',
      summary: `${playerLabel}: ${result.item} ${result.swapped ? 'swapped' : 'moved'} ${fromSpec.rconSlot} -> ${toSpec.rconSlot} (${ctx.mechanism === 'rcon' ? 'live' : 'file edit'})`,
      details: {
        player: playerLabel,
        uuid: ctx.uuid,
        op: 'move',
        from,
        to,
        item: result.item,
        count: result.count,
        swapped: result.swapped,
        via: ctx.mechanism,
      },
    });
    return {
      ...result,
      player: playerLabel,
      mechanism: ctx.mechanism,
      from: fromSpec.rconSlot,
      to: toSpec.rconSlot,
    };
  }

  /** Add an item to the first free hotbar/main slot — works online and offline. */
  async addItem(
    serverId: string,
    uuid: string,
    itemId: string,
    count: number = 1,
    { actor = 'system' }: { actor?: string } = {},
  ): Promise<AddItemResult> {
    const item = assertItemId(itemId);
    const resolvedCount = clampCount(count);
    const ctx = await this.editContext(serverId, uuid);
    if (ctx.mechanism === 'rcon') {
      const gave = await this.giveItem(
        serverId,
        ctx.name!,
        item,
        resolvedCount,
        { actor },
      );
      return { ...gave, slot: -1, mechanism: 'rcon' };
    }
    const playerLabel = ctx.name || ctx.uuid;
    const slot = await this.playerDataFiles.withDatFile(
      serverId,
      ctx,
      (root) => {
        const entries = rawItemList(root, 'Inventory', { create: true })!;
        const used = new Set(
          entries.filter((e) => e && e.Slot).map((e) => Number(e.Slot.value)),
        );
        let free = -1;
        for (let n = 0; n <= 35; n++) {
          if (!used.has(n)) {
            free = n;
            break;
          }
        }
        if (free === -1)
          throw new BadRequestException(
            'Their inventory is full — no free slot to add into',
          );
        entries.push({
          ...makeRawItem(item, resolvedCount),
          Slot: { type: 'byte', value: free },
        });
        return free;
      },
    );
    this.events.recordEvent({
      serverId,
      actor,
      type: 'inventory-edit',
      summary: `${playerLabel}: ${resolvedCount}x ${item} added to slot ${slot} (file edit)`,
      details: {
        player: playerLabel,
        uuid: ctx.uuid,
        op: 'add',
        item,
        count: resolvedCount,
        slot,
        via: 'file',
      },
    });
    return {
      player: playerLabel,
      item,
      count: resolvedCount,
      slot,
      mechanism: 'file',
    };
  }
}
