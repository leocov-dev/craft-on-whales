import { Injectable } from '@nestjs/common';
import { ServerQueryService } from '../servers/server-query.service';
import {
  PlayerDataFileService,
  iterateItems,
} from './player-data-file.service';
import type { PlayerInventoryData } from '../../../shared/types/inventory';

export interface ItemSearchHit {
  player: { uuid: string; name: string | null };
  where: string;
  slot: number | null;
  id: string;
  count: number;
  displayName: string | null;
}

/**
 * Cross-player and cross-server item search over playerdata. Extracted from
 * InventoryService (see `.plan/reviews/05-inventory-blueprints-items.md`,
 * "InventoryService is a God class") — pure read/scan, no mutation.
 */
@Injectable()
export class ItemSearchService {
  constructor(
    private readonly serverQuery: ServerQueryService,
    private readonly playerDataFiles: PlayerDataFileService,
  ) {}

  /**
   * Scan every playerdata file for items whose id or display name contains
   * `query` (case-insensitive). Unreadable files are skipped, never fatal.
   */
  async searchItems(
    serverId: string,
    query: string | null | undefined,
    { limit = 500 }: { limit?: number } = {},
  ): Promise<ItemSearchHit[]> {
    const q = String(query || '')
      .trim()
      .toLowerCase();
    if (!q) return [];
    const results: ItemSearchHit[] = [];
    for (const player of await this.playerDataFiles.listPlayersWithData(
      serverId,
    )) {
      let data: PlayerInventoryData;
      try {
        data = await this.playerDataFiles.readPlayerData(serverId, player.uuid);
      } catch {
        continue; // corrupt or in-flight write — skip this player
      }
      for (const [where, item] of iterateItems(data)) {
        const matches =
          item.id.toLowerCase().includes(q) ||
          (item.displayName && item.displayName.toLowerCase().includes(q));
        if (!matches) continue;
        results.push({
          player: { uuid: player.uuid, name: player.name },
          where,
          slot: item.slot,
          id: item.id,
          count: item.count,
          displayName: item.displayName || null,
        });
        if (results.length >= limit) return results;
      }
    }
    return results;
  }

  /** searchItems across every server: [{serverId, serverName, ...hit}]. */
  async searchAllServers(
    query: string | null | undefined,
    { limit = 500 }: { limit?: number } = {},
  ): Promise<(ItemSearchHit & { serverId: string; serverName: string })[]> {
    const results: (ItemSearchHit & {
      serverId: string;
      serverName: string;
    })[] = [];
    for (const server of await this.serverQuery.listServers()) {
      if (results.length >= limit) break;
      let hits: ItemSearchHit[] = [];
      try {
        hits = await this.searchItems(server.id, query, {
          limit: limit - results.length,
        });
      } catch {
        continue; // one bad server must not sink the global search
      }
      for (const hit of hits) {
        results.push({
          serverId: server.id,
          serverName: server.display_name,
          ...hit,
        });
      }
    }
    return results;
  }
}
