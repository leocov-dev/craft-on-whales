/** `GET /status/api/:slug` — the public, unauthenticated status page. */
export interface StatusPageData {
  name: string;
  icon: string;
  accent: string;
  motd: string;
  flavor: string;
  mcVersion: string;
  status: string;
  online: number;
  max: number;
  uptime: string | null;
}
