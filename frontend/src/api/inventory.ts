// Wraps /api/servers/:id/inventory (src/web/routes/inventory.ts). Scoped to
// viewing + give/clear for the first pass — full drag/drop slot editing (the
// original's ~1000-line MUST-USE widget) is a follow-up.

import { http } from './http';
import type { PlayerWithData, NormalizedItem, PlayerInventoryData } from '../../../shared/types/inventory';

export type { PlayerWithData, NormalizedItem, PlayerInventoryData };

interface PlayersResponse {
  ok: true;
  running: boolean;
  players: PlayerWithData[];
}

interface PlayerResponse {
  ok: true;
  running: boolean;
  player: PlayerInventoryData;
  iconBase: string;
  edit: { online: boolean; mechanism: 'rcon' | 'file'; nestedEditable: boolean };
}

export const inventoryApi = {
  listPlayers: (serverId: string) =>
    http.get<PlayersResponse>(`/api/servers/${serverId}/inventory/players`),
  getPlayer: (serverId: string, uuid: string, fresh = false) =>
    http.get<PlayerResponse>(
      `/api/servers/${serverId}/inventory/player/${uuid}${fresh ? '?fresh=1' : ''}`,
    ),
  give: (serverId: string, player: string, item: string, count?: number) =>
    http.post<{ ok: true; result: unknown }>(`/api/servers/${serverId}/inventory/give`, {
      player,
      item,
      count,
    }),
  clear: (serverId: string, player: string, item?: string) =>
    http.post<{ ok: true; result: unknown }>(`/api/servers/${serverId}/inventory/clear`, {
      player,
      item,
    }),
};
