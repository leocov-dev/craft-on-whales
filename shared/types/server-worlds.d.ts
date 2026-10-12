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

/** One dimension's region files, as chunk slots that exist. */
export interface WorldChunkDimension {
  /** Region folder relative to the world folder (e.g. `.`, `DIM-1`); also the id used by the other chunk routes. */
  label: string;
  regions: Array<{
    rx: number;
    rz: number;
    /** Occupied slots 0..1023 within the region (`x + z * 32`). */
    slots: number[];
  }>;
}

/** `GET /api/servers/:id/worlds/:world/chunks` */
export interface WorldChunkMap {
  worldName: string;
  dimensions: WorldChunkDimension[];
  /** Spawn chunk and where it came from. */
  spawn: { cx: number; cz: number; source: 'level.dat' | 'origin' };
}

/** `POST /api/servers/:id/worlds/chunks/delete` */
export interface DeleteChunksResult {
  worldName: string;
  dimension: string;
  /** Chunks actually removed (selected chunks that didn't exist are not counted). */
  chunksRemoved: number;
  regionsChanged: number;
  /** Selected regions whose file couldn't be repacked safely and was left untouched. */
  regionsSkipped: number;
  /** Why each skipped region file was left alone (file is relative to the dimension folder). */
  skippedRegions: Array<{ file: string; reason: string }>;
  backedUp: boolean;
}
