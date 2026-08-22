'use strict';

// Shared types for the "mods & content" services group (mods.ts, packs.ts,
// modBrowser.ts, modrinthApi.ts, curseforgeApi.ts, gtnhApi.ts, javaMatrix.ts).
// Extracted to their own type-only file — rather than living inside a file
// that also has a CommonJS `export =` value statement — because tsx's
// esbuild-based CJS loader transforms each file independently and can
// silently drop type-only exports mixed into such a file at runtime.

/** Minimal server-row shape used by content/pack management. The full row type
 *  lives in src/services/servers.js (not yet converted). */
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
