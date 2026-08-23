// Shared types for the mods & content services group (mods.ts, modBrowser.ts,
// modrinthApi.ts, curseforgeApi.ts, gtnhApi.ts), ported from legacy
// src/services/types.ts's Modrinth/CurseForge section.

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

/** Resolved-URL/slug result shared by ModrinthApiService.resolveUrl. */
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
  downloads?: number;
  body?: string;
}

/** One file attached to a Modrinth version. */
export interface ModrinthFile {
  url: string;
  filename: string;
  primary: boolean;
  // Always present on the real API response (mrFetch passes the raw JSON
  // through); declared here so callers that need the checksums/size for a
  // .mrpack manifest (InvitesService) don't have to re-cast.
  hashes: { sha1: string; sha512: string };
  size: number;
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

/** Resolved-URL/slug result shared by CurseforgeApiService.resolveUrl. */
export interface CurseforgeResolved extends CurseforgeMod {
  fileId: number | null;
}
