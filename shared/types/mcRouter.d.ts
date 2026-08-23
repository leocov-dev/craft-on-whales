/** `GET /api/mc-router`'s `config` field. */
export interface McRouterConfig {
  enabled: boolean;
  listenPort: number;
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
  hostname: string | null;
  autoScale: string | null;
}
