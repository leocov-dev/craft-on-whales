/** `GET /api/servers/:id/worlds/`'s per-server world listing entry. */
export interface ServerWorldSummary {
  name: string;
  active: boolean;
  dims: string[];
  sizeBytes: number;
  seed: string | null;
}
