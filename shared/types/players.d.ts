/**
 * Roster status label — derived from fields already on the entry, in
 * precedence order: an online player reads `Online` even if also banned or
 * whitelisted; otherwise a banned player reads `Banned` even if also
 * whitelisted (a ban blocks connects regardless of whitelist); otherwise
 * whitelisted reads `Whitelisted` (approved, can join, whether or not they
 * ever have); otherwise a player who has joined before (has a `lastSeen`)
 * reads `Joined`; `Unknown` is the fallback for an entry that reached the
 * roster through none of the above (e.g. a manually-added `ops.json` entry
 * for a player who was never whitelisted, banned, or seen online/in
 * usercache) — see PLAYERS_NOTES.md.
 */
export type PlayerStatus = 'Online' | 'Banned' | 'Whitelisted' | 'Joined' | 'Unknown';

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
  /** Derived display status — see `PlayerStatus`. */
  status: PlayerStatus;
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
