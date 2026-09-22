/** `GET /api/mc-router`'s `config` field. */
export interface McRouterConfig {
  enabled: boolean;
  listenPort: number;
  /** Domain appended to each server's subdomain to form its route hostname
   *  (e.g. "example.com" + subdomain "survival" -> "survival.example.com").
   *  Empty until an admin sets one, in which case a server's stored
   *  subdomain value is used as-is (full-hostname fallback, for values set
   *  before this field existed). */
  baseDomain: string;
  autoScaleUp: boolean;
  autoScaleDown: boolean;
  autoScaleDownAfter: string;
  autoScaleAsleepMotd: string;
  autoScaleLoadingMotd: string;
}

/** `GET /api/mc-router`'s `routes` field — one entry per routed server. */
export interface RouterRoute {
  id: string;
  name: string;
  containerName: string;
  /** Raw stored value (a subdomain label once `baseDomain` is set, else a full hostname). */
  subdomain: string | null;
  /** Full hostname players connect to, composed with the current `baseDomain`. */
  hostname: string | null;
  autoScale: 'on' | 'off' | null;
}
