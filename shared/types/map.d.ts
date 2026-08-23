/** `GET /api/servers/:id/map`'s response fields (BlueMap sidecar status). */
export interface MapConfig {
  enabled: boolean;
  hostPort: number | null;
  supported: boolean;
}
