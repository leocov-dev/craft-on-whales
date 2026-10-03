/** Tick-rate reading; every field is null when the server doesn't report it. */
export interface TpsReading {
  tps1: number | null;
  tps5: number | null;
  tps15: number | null;
  mspt: number | null;
  source: 'paper' | 'spark' | 'forge';
}

/** `GET /api/servers/:id/health` — the Live tab's Health & Stability card. */
export interface ServerHealth {
  status: string;
  /** Docker healthcheck state, null when the container has none. */
  health: string | null;
  exitCode: number | null;
  oomKilled: boolean;
  startedAt: string | null;
  /** Counts over `windowDays`. */
  windowDays: number;
  crashes: number;
  oomKills: number;
  crashLoops: number;
  stalledStarts: number;
  lastCrash: { at: string; summary: string } | null;
  /** Newest crash-report file, if any. */
  lastCrashReport: { id: string; filename: string; summary: string } | null;
}

/** One running server's live resource use. */
export interface ServerUsage {
  id: string;
  name: string;
  cpuPct: number;
  memUsedBytes: number;
  memLimitBytes: number;
}

/** `GET /api/monitoring/overview` — the dashboard's combined resource graphs. */
export interface ResourceOverview {
  servers: ServerUsage[];
  /** Host-wide totals across `servers`. */
  totals: { cpuPct: number; memUsedBytes: number; memLimitBytes: number };
}
