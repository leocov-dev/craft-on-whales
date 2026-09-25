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
  /** null = permanent ban (or not banned). Vanilla's own `banTimestamp` format. */
  banExpires: string | null;
  lastSeen: string | null;
  /** Last IP seen joining, from the console log's "logged in with entity id" line — null if never captured. */
  lastKnownIp: string | null;
}

export interface BannedIpEntry {
  ip: string;
  reason: string | null;
  created: string | null;
  source: string | null;
  expires: string;
  /** Player name this IP ban is tagged as belonging to, if the admin linked one. */
  player: string | null;
}

/** A moderator note attached to a player. See PLAYERS_NOTES.md. */
export interface PlayerNote {
  id: string;
  uuid: string;
  name: string;
  note: string;
  author: string;
  createdAt: string;
}
