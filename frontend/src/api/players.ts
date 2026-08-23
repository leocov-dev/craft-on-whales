// Wraps /api/servers/:id/players (src/web/routes/players.ts).

import { http } from './http';
import type { PlayerListEntry, BannedIpEntry } from '../../../shared/types/players';

export type { PlayerListEntry, BannedIpEntry };

interface PlayersResponse {
  ok: true;
  running: boolean;
  players: PlayerListEntry[];
  bannedIps: BannedIpEntry[];
  whitelistEnforced: boolean;
}

export const playersApi = {
  list: (serverId: string) => http.get<PlayersResponse>(`/api/servers/${serverId}/players`),
  setWhitelist: (serverId: string, name: string, on: boolean) =>
    http.post<{ ok: true }>(`/api/servers/${serverId}/players/whitelist`, { name, on }),
  setWhitelistEnforced: (serverId: string, on: boolean) =>
    http.post<{ ok: true }>(`/api/servers/${serverId}/players/whitelist-enforce`, { on }),
  setOp: (serverId: string, name: string, on: boolean, level?: number) =>
    http.post<{ ok: true }>(`/api/servers/${serverId}/players/op`, { name, on, level }),
  ban: (serverId: string, name: string, reason?: string) =>
    http.post<{ ok: true }>(`/api/servers/${serverId}/players/ban`, { name, reason }),
  pardon: (serverId: string, name: string) =>
    http.post<{ ok: true }>(`/api/servers/${serverId}/players/pardon`, { name }),
  banIp: (serverId: string, ip: string, reason?: string) =>
    http.post<{ ok: true }>(`/api/servers/${serverId}/players/ban-ip`, { ip, reason }),
  pardonIp: (serverId: string, ip: string) =>
    http.post<{ ok: true }>(`/api/servers/${serverId}/players/pardon-ip`, { ip }),
  kick: (serverId: string, name: string, message?: string) =>
    http.post<{ ok: true }>(`/api/servers/${serverId}/players/kick`, { name, message }),
};
