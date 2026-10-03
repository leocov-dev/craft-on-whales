/** `GET /api/servers/:id/worlds/`'s per-server world listing entry. */
export interface ServerWorldSummary {
  name: string;
  active: boolean;
  dims: string[];
  sizeBytes: number;
  seed: string | null;
}

/** `POST /api/servers/:id/worlds/shrink` — outcome of a shrink (or its dry run). */
export interface ShrinkWorldResult {
  worldName: string;
  /** Region folders covered, relative to the world folder (e.g. `.`, `DIM-1`). */
  dimensions: string[];
  regionsScanned: number;
  /** Region files left untouched because they couldn't be read or repacked safely. */
  regionsSkipped: number;
  chunksScanned: number;
  chunksRemoved: number;
  /** Chunks kept because their InhabitedTime couldn't be read. */
  chunksUnreadable: number;
  bytesFreed: number;
  dryRun: boolean;
  minInhabitedTicks: number;
  spawnKeepChunks: number;
  /** Spawn chunk used for protection, and where it came from. */
  spawn: { cx: number; cz: number; source: 'level.dat' | 'origin' };
}
