export interface MojangVersionEntry {
  id: string;
  type: string;
  releaseTime: string;
}

/** `GET /api/ports/suggest`'s `ports` field. */
export interface SuggestedPorts {
  game: number;
  rcon: number;
  bedrock: number | null;
}

/** `POST /api/servers` request body. */
export interface CreateServerInput {
  name: string;
  description?: string;
  type: string;
  mcVersion?: string;
  portGame?: number;
  heapMb?: number;
  containerMemoryMb?: number;
  diskQuotaGb?: number;
  start?: boolean;
}

/**
 * `POST /api/servers`'s (and every lifecycle action's) `server` field is
 * actually the full internal server row minus secrets (`publicServer()`,
 * snake_case DB column names) — NOT a narrow `{id, name, type, mcVersion,
 * portGame}` shape. This lists only the fields safe to rely on here rather
 * than typing that whole internal row as a public contract; if you need
 * more of it, check `backend/src/servers/types.ts`'s `Server` interface for
 * what's really there before assuming a field exists.
 */
export interface CreatedServerSummary {
  id: string;
  display_name: string;
  type: string;
  mc_version: string;
  port_game: number;
}
