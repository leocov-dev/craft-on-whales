/** Merged player-list entry — everything ever seen about one player. Returned by `GET /api/servers/:id/players`. */
export interface PlayerListEntry {
  name: string;
  bedrock: boolean;
  uuid: string | null;
  online: boolean;
  whitelisted: boolean;
  op: boolean;
  opLevel: number | null;
  bypassesPlayerLimit: boolean;
  banned: boolean;
  banReason: string | null;
  banDate: string | null;
  banSource: string | null;
  lastSeen: string | null;
}

export interface BannedIpEntry {
  ip: string;
  reason: string | null;
  created: string | null;
  source: string | null;
  expires: string;
}
