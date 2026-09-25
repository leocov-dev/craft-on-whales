// Wraps /api/servers/:id/players (src/web/routes/players.ts).

import { http } from './http';
import type {
  PlayerListEntry,
  PlayerStatus,
  BannedIpEntry,
  PlayerNote,
} from '../../../shared/types/players';

export type { PlayerListEntry, PlayerStatus, BannedIpEntry, PlayerNote };

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
  ban: (serverId: string, name: string, reason?: string, durationMs?: number) =>
    http.post<{ ok: true; result: { banExpires: string | null } }>(
      `/api/servers/${serverId}/players/ban`,
      { name, reason, durationMs },
    ),
  pardon: (serverId: string, name: string) =>
    http.post<{ ok: true }>(`/api/servers/${serverId}/players/pardon`, { name }),
  banIp: (
    serverId: string,
    ip: string,
    reason?: string,
    opts?: { durationMs?: number | undefined; player?: string | undefined },
  ) =>
    http.post<{ ok: true }>(`/api/servers/${serverId}/players/ban-ip`, {
      ip,
      reason,
      durationMs: opts?.durationMs,
      player: opts?.player,
    }),
  pardonIp: (serverId: string, ip: string) =>
    http.post<{ ok: true }>(`/api/servers/${serverId}/players/pardon-ip`, { ip }),
  kick: (serverId: string, name: string, message?: string) =>
    http.post<{ ok: true }>(`/api/servers/${serverId}/players/kick`, { name, message }),
  /** Irreversible: whitelist/op/ban roster state, offline playerdata, snapshots, and notes. Refused while online. */
  deletePlayer: (serverId: string, name: string) =>
    http.delete<{ ok: true }>(`/api/servers/${serverId}/players/${encodeURIComponent(name)}`),
  lastKnownIp: (serverId: string, name: string) =>
    http.get<{ ok: true; ip: string | null }>(
      `/api/servers/${serverId}/players/${encodeURIComponent(name)}/last-ip`,
    ),
  listNotes: (serverId: string, name: string) =>
    http.get<{ ok: true; notes: PlayerNote[] }>(
      `/api/servers/${serverId}/players/notes?name=${encodeURIComponent(name)}`,
    ),
  addNote: (serverId: string, name: string, note: string) =>
    http.post<{ ok: true; note: PlayerNote }>(`/api/servers/${serverId}/players/notes`, {
      name,
      note,
    }),
  deleteNote: (serverId: string, noteId: string) =>
    http.delete<{ ok: true }>(`/api/servers/${serverId}/players/notes/${noteId}`),
};
