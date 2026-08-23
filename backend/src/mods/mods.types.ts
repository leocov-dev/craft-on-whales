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

/** Parsed `pack.toml` (https://packwiz.infra.link/reference/pack-format/pack-toml/) — fields this codebase reads. */
export interface PackwizPackToml {
  name: string;
  author?: string;
  version?: string;
  'pack-format': string;
  index: { file: string; 'hash-format': string; hash: string };
  versions: {
    minecraft: string;
    fabric?: string;
    forge?: string;
    liteloader?: string;
    quilt?: string;
    neoforge?: string;
  };
}

/** Parsed `index.toml` (https://packwiz.infra.link/reference/pack-format/index-toml/) — fields this codebase reads. */
export interface PackwizIndexToml {
  'hash-format': string;
  files?: {
    file: string;
    hash: string;
    'hash-format'?: string;
    alias?: string;
    metafile?: boolean;
    preserve?: boolean;
  }[];
}

/** Parsed per-mod `*.toml` (https://packwiz.infra.link/reference/pack-format/mod-toml/) — fields this codebase reads. */
export interface PackwizModToml {
  name: string;
  filename: string;
  side?: 'both' | 'client' | 'server';
  download: {
    url?: string;
    'hash-format': string;
    hash: string;
    mode?: string;
  };
  update?: {
    curseforge?: { 'project-id': number; 'file-id': number };
    modrinth?: { 'mod-id': string; version: string };
  };
}

/** A packwiz pack, resolved from a `pack.toml` URL — the pack + its index, ready to hash/pin/list. */
export interface PackwizResolved {
  packUrl: string;
  pack: PackwizPackToml;
  indexText: string;
  index: PackwizIndexToml;
  indexHash: string;
}

/** One mod entry surfaced by the packwiz details modal. */
export interface PackwizModInfo {
  name: string;
  filename: string;
  side: 'both' | 'client' | 'server';
  updatePlatform: 'curseforge' | 'modrinth' | null;
}
