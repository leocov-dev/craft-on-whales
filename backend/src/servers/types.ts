// Shared types for the servers group, mirroring legacy src/services/types.ts's
// "server lifecycle & scheduling" section.

/** One entry in a server's `extra_ports_json` (Docker Advanced settings). */
export interface ServerExtraPort {
  hostPort: number;
  containerPort: number;
  protocol: 'tcp' | 'udp';
  label?: string;
}

/** One entry in a server's `extra_binds_json` (Docker Advanced settings). */
export interface ServerExtraBind {
  hostPath: string;
  containerPath: string;
  mode?: 'rw' | 'ro';
}

/**
 * A `servers` row, normalized by ServerQueryService's rowToServer(): the
 * *_json columns parsed, and container_name/network_name available under
 * both their raw and camelCase field names (routes depend on both being
 * present, matching legacy's publicServer() response shape).
 */
export interface Server {
  id: string;
  display_name: string;
  description: string;
  icon: string;
  accent: string;
  tags: string[];
  notes: string;
  type: string;
  mc_version: string;
  java_tag: string;
  env: Record<string, string>;
  port_game: number;
  port_rcon: number;
  port_query: number | null;
  port_bedrock: number | null;
  rcon_password_cipher: string;
  heap_mb: number;
  container_memory_mb: number;
  container_swap_mb: number;
  cpus: number;
  disk_quota_bytes: number;
  quota_strict: number;
  update_policy: 'manual' | 'notify' | 'auto';
  auto_start: number;
  auto_restart: number;
  container_id: string | null;
  pending_recreate: number;
  status: string;
  last_started_at: string | null;
  created_at: string;
  deleted_at: string | null;
  console_label: string | null;
  container_name: string | null;
  network_name: string | null;
  containerName: string | null;
  networkName: string | null;
  router_hostname: string | null;
  router_auto_scale: string | null;
  routerHostname: string | null;
  routerAutoScale: string | null;
  extraPorts: ServerExtraPort[];
  extraBinds: ServerExtraBind[];
}
