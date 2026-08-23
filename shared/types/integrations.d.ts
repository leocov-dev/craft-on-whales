export interface EventToggles {
  lifecycle: boolean;
  crashes: boolean;
  backups: boolean;
  updates: boolean;
  players: boolean;
}

/** `GET /api/servers/:id/integrations`'s `discord` field. The real webhook
 *  URL is never sent back once set — only whether one is configured and a
 *  masked preview, so a client can't leak it just by loading this page. */
export interface DiscordConfig {
  enabled: boolean;
  hasWebhook: boolean;
  webhookMasked: string | null;
  events: EventToggles;
}

/** `POST /api/servers/:id/integrations/discord` request body. `webhookUrl`:
 *  omit to keep the current one, `''`/`null` to clear it, a new URL to set it. */
export interface SetDiscordConfigInput {
  enabled?: boolean;
  webhookUrl?: string | null;
  events?: Partial<EventToggles>;
}

export interface StatusPageConfig {
  enabled: boolean;
  slug: string | null;
  path: string | null;
}

/** `GET /api/servers/:id/integrations/invite` — everything the "invite a friend" panel needs. */
export interface InviteInfo {
  serverId: string;
  name: string;
  port: number;
  candidates: string[];
  publicIp: string | null;
  publicAddress: string | null;
  portForwardGuidance: string;
  mcVersion: string;
  flavor: string;
  whitelistEnforced: boolean;
  modCount: number;
  manualMods: { name: string; filename: string | null }[];
  inviteText: string;
  modded: boolean;
}
