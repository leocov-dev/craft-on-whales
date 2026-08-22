'use strict';

// Shared types for the "mods & content" services group (mods.ts, packs.ts,
// modBrowser.ts, modrinthApi.ts, curseforgeApi.ts, gtnhApi.ts, javaMatrix.ts).
// Extracted to their own type-only file — rather than living inside a file
// that also has a CommonJS `export =` value statement — because tsx's
// esbuild-based CJS loader transforms each file independently and can
// silently drop type-only exports mixed into such a file at runtime.

/** Minimal server-row shape used by content/pack management — a structural
 *  subset of `Server` below (src/services/servers.ts owns the full type). */
export interface ContentServer {
  id: string;
  type: string;
  env: Record<string, string>;
  mc_version: string;
  display_name: string;
  /** Legacy/dead field read by mods.ts's listContent(); servers.js's rowToServer
   *  never actually sets it, so it is always falsy in practice. */
  pack?: unknown;
}

export type ModPlatform = 'modrinth' | 'curseforge';

/** A Modrinth search hit, normalized from the raw API response. */
export interface ModrinthSearchHit {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  iconUrl: string | null;
  downloads: number;
  categories: string[];
  latestVersion: string;
}

/** A CurseForge project, normalized from the raw API response. */
export interface CurseforgeMod {
  modId: number;
  slug: string;
  name: string;
  summary: string;
  iconUrl: string | null;
  downloads: number;
  classId: number;
  latestFiles: CurseforgeFile[];
}

/** A CurseForge file (version), normalized from the raw API response. */
export interface CurseforgeFile {
  fileId: number;
  name: string;
  fileName: string;
  downloadUrl: string | null;
  gameVersions: string[];
  releaseType: 'release' | 'beta' | 'alpha';
  fileDate: string;
  fileLength: number;
  hashes: unknown[];
  serverPackFileId: number | null;
  dependencies: { modId: number; relation: number }[];
}

/** Resolved-URL/slug result shared by modrinthApi.resolveUrl. */
export interface ModrinthResolved {
  projectId: string;
  slug: string;
  title: string;
  iconUrl: string | null;
  projectType: string;
  versionId: string | null;
}

/** A Modrinth project, as returned by GET /project/{id|slug} (fields this codebase reads). */
export interface ModrinthProject {
  id: string;
  slug: string;
  title: string;
  icon_url?: string | null;
  project_type: string;
}

/** One file attached to a Modrinth version. */
export interface ModrinthFile {
  url: string;
  filename: string;
  primary: boolean;
}

/** A required-dependency entry inside a Modrinth version's `dependencies` array. */
export interface ModrinthDependency {
  project_id?: string | null;
  dependency_type?: string;
}

/** A Modrinth version, as returned by the /version endpoints (fields this codebase reads). */
export interface ModrinthVersion {
  id: string;
  name?: string;
  version_number: string;
  date_published?: string | null;
  version_type?: string;
  game_versions: string[];
  loaders?: string[];
  files: ModrinthFile[];
  dependencies?: ModrinthDependency[];
}

/** Resolved-URL/slug result shared by curseforgeApi.resolveUrl. */
export interface CurseforgeResolved extends CurseforgeMod {
  fileId: number | null;
}

// ---------------------------------------------------------------------------
// "server lifecycle & scheduling" group (servers.ts, dockerSpec.ts,
// worlds.ts, backups.ts, map.ts, worldControls.ts, files.ts, scheduler.ts) —
// see the note atop ContentServer for why these live here instead of in
// servers.ts alongside its `export =`.

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
 * A `servers` row (see db/migrations/001_init.ts, 006_console_label.ts,
 * 007_docker_advanced.ts) normalized by servers.ts's rowToServer(): the
 * *_json columns parsed, and container_name/network_name renamed to their
 * camelCase field names. This is the shape every other service works with —
 * ContentServer (below) is a read-only structural subset of it for the mods/
 * content group, which only reads a handful of these fields.
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
  // Raw columns kept alongside their camelCase counterparts below: the
  // original JS rowToServer() spread the whole row before adding derived
  // fields, so both `container_name` and `containerName` (etc.) exist on the
  // public API response — routes like publicServer() in web/routes/api.js
  // depend on the snake_case originals being present too.
  container_name: string | null;
  network_name: string | null;
  containerName: string | null;
  networkName: string | null;
  extraPorts: ServerExtraPort[];
  extraBinds: ServerExtraBind[];
}
