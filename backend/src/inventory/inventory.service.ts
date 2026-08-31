import { Injectable } from '@nestjs/common';
import { PlayerDataFileService } from './player-data-file.service';
import { ItemSearchService } from './item-search.service';
import { InventorySnapshotService } from './inventory-snapshot.service';
import { InventoryWatcherService } from './inventory-watcher.service';
import { InventoryEditService } from './inventory-edit.service';
import type {
  PlayerWithData,
  PlayerInventoryData,
} from '../../../shared/types/inventory';

export type { PlayerWithData, PlayerInventoryData };
export type { ItemSearchHit } from './item-search.service';
export type {
  SnapshotMeta,
  SnapshotMetaWithSize,
  LoadedSnapshot,
  SnapshotDiff,
} from './inventory-snapshot.service';
export type {
  GiveResult,
  ClearResult,
  EditContext,
  EditSlotResult,
  MoveItemResult,
  AddItemResult,
} from './inventory-edit.service';

/**
 * Inventory forensics + god-mode editing — thin coordinator over its
 * collaborators. Offline NBT inspection of playerdata (.dat) files, item
 * search across players and servers, point-in-time JSON snapshots with
 * diffing, RCON give/clear, and per-slot editing (set/delete/count/move)
 * that auto-picks its mechanism: RCON `item replace entity` while the player
 * is online, direct .dat rewrites (gzip'd NBT, with rotating backups) while
 * they are not. Originally ported from src/services/inventory.ts as one
 * ~1,420-line class; split per
 * `.plan/reviews/05-inventory-blueprints-items.md` ("InventoryService is a
 * God class") into:
 *  - PlayerDataFileService: offline .dat I/O, usercache lookups, backups/locking
 *  - ItemSearchService: cross-player / cross-server item search
 *  - InventorySnapshotService: JSON snapshot CRUD + diffing
 *  - InventoryWatcherService: background DB-poll auto-snapshot watcher
 *  - InventoryEditService: RCON give/clear + RCON-vs-file god-mode slot editing
 * This class keeps the public surface `InventoryController` and other
 * modules call and simply delegates.
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly playerDataFiles: PlayerDataFileService,
    private readonly itemSearch: ItemSearchService,
    private readonly snapshots: InventorySnapshotService,
    private readonly watcher: InventoryWatcherService,
    private readonly edits: InventoryEditService,
  ) {}

  // -------------------------------------------------------------- playerdata read

  readPlayerData(
    serverId: string,
    uuidInput: string,
  ): Promise<PlayerInventoryData> {
    return this.playerDataFiles.readPlayerData(serverId, uuidInput);
  }

  listPlayersWithData(serverId: string): Promise<PlayerWithData[]> {
    return this.playerDataFiles.listPlayersWithData(serverId);
  }

  // -------------------------------------------------------------- item search

  searchItems(
    serverId: string,
    query: string | null | undefined,
    opts: { limit?: number } = {},
  ) {
    return this.itemSearch.searchItems(serverId, query, opts);
  }

  searchAllServers(
    query: string | null | undefined,
    opts: { limit?: number } = {},
  ) {
    return this.itemSearch.searchAllServers(query, opts);
  }

  // -------------------------------------------------------------- snapshots

  snapshot(serverId: string, uuid: string, reason: string = 'manual') {
    return this.snapshots.snapshot(serverId, uuid, reason);
  }

  listSnapshots(serverId: string, uuidInput: string) {
    return this.snapshots.listSnapshots(serverId, uuidInput);
  }

  getSnapshot(relFile: string) {
    return this.snapshots.getSnapshot(relFile);
  }

  diffSnapshots(aFile: string, bFile: string) {
    return this.snapshots.diffSnapshots(aFile, bFile);
  }

  pruneSnapshots(serverId: string, keepPerPlayer: number = 50) {
    return this.snapshots.pruneSnapshots(serverId, keepPerPlayer);
  }

  // -------------------------------------------------------------- automatic snapshots

  startSnapshotWatcher(opts: { intervalMs?: number } = {}): void {
    this.watcher.startSnapshotWatcher(opts);
  }

  // -------------------------------------------------------------- RCON give/clear

  giveItem(
    serverId: string,
    playerName: string,
    itemId: string,
    count: number = 1,
    opts: { actor?: string } = {},
  ) {
    return this.edits.giveItem(serverId, playerName, itemId, count, opts);
  }

  clearItem(
    serverId: string,
    playerName: string,
    itemId: string | null = null,
    opts: { actor?: string } = {},
  ) {
    return this.edits.clearItem(serverId, playerName, itemId, opts);
  }

  // -------------------------------------------------------------- god-mode edit context

  editContext(serverId: string, uuidInput: string) {
    return this.edits.editContext(serverId, uuidInput);
  }

  flushPlayerData(serverId: string): Promise<boolean> {
    return this.edits.flushPlayerData(serverId);
  }

  // ----------------------------------------------------------- public edit API

  editSlot(
    serverId: string,
    uuid: string,
    body: Parameters<InventoryEditService['editSlot']>[2],
    opts: { actor?: string } = {},
  ) {
    return this.edits.editSlot(serverId, uuid, body, opts);
  }

  moveItem(
    serverId: string,
    uuid: string,
    from: { container: string; slot: number | string },
    to: { container: string; slot: number | string },
    opts: { actor?: string } = {},
  ) {
    return this.edits.moveItem(serverId, uuid, from, to, opts);
  }

  addItem(
    serverId: string,
    uuid: string,
    itemId: string,
    count: number = 1,
    opts: { actor?: string } = {},
  ) {
    return this.edits.addItem(serverId, uuid, itemId, count, opts);
  }
}
