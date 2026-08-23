export type ServerStatus =
  | 'running'
  | 'unhealthy'
  | 'starting'
  | 'updating'
  | 'crashed'
  | 'over-quota'
  | 'stopped';

export interface PackViewModel {
  platform: string;
  name: string;
  version: string;
  versionId: string;
  latest: string;
  latestVersionId: string | null;
}

/** The server view model returned by `GET /api/servers` and `GET /api/servers/:id`. */
export interface ServerViewModel {
  id: string;
  name: string;
  description: string;
  icon: string;
  accent: string;
  tags: string[];
  type: string;
  flavor: string;
  loader: string | null;
  mcVersion: string;
  javaTag: string;
  status: ServerStatus;
  ports: { game: number; rcon: number; bedrock: number | null };
  resources: { heapMb: number; containerMemoryMb: number; cpus: number };
  stats: { cpuPct: number; memUsedMb: number; uptime: string | null };
  players: { online: number; max: number; names: string[] };
  disk: { used: number; quota: number };
  pack: PackViewModel | null;
  updateAvailable: boolean;
  crashesUnread: number;
  autoStart: boolean;
  autoRestart: boolean;
  notes: string;
  updatePolicy: 'manual' | 'notify' | 'auto';
  pendingRecreate: boolean;
  lastStarted: string;
  created: string;
  consoleLabel: string;
  statusDetail?: string;
}

/** `GET /api/servers/live`'s per-server hydration payload. */
export interface LiveServerData {
  status: ServerStatus;
  cpuPct: number | null;
  memUsedMb: number | null;
  players: { online: number; max: number; names: string[] } | null;
  startedAt: string | null;
  phase: string | null;
}

export type LifecycleAction = 'start' | 'stop' | 'restart' | 'kill' | 'recreate';

/** `ServerViewModel` plus the Docker Advanced fields only the detail endpoint returns. */
export interface ServerDetail extends ServerViewModel {
  containerName: string | null;
  networkName: string | null;
  extraPorts: { hostPort: number; containerPort: number; protocol: 'tcp' | 'udp' }[];
  extraBinds: { hostPath: string; containerPath: string; readOnly?: boolean }[];
  addresses: string[];
}

/** `PATCH /api/servers/:id` request body. */
export interface ServerPatch {
  name?: string;
  description?: string;
  icon?: string;
  accent?: string;
  tags?: string[];
  notes?: string;
  mcVersion?: string;
  javaTag?: string;
  heapMb?: number;
  containerMemoryMb?: number;
  cpus?: number;
  diskQuotaGb?: number;
  updatePolicy?: 'manual' | 'notify' | 'auto';
  autoStart?: boolean;
  autoRestart?: boolean;
  env?: Record<string, string>;
}
