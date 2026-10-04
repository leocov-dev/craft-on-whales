// Shared types for the mods & content services group (mods.ts, modBrowser.ts,
// modrinthApi.ts, curseforgeApi.ts, gtnhApi.ts), ported from legacy
// src/services/types.ts's Modrinth/CurseForge section.

/** Every registry installFromUrl can resolve a project on (stored as library_files.platform). */
export type ModPlatform =
  'modrinth' | 'curseforge' | 'hangar' | 'spiget' | 'github';

/**
 * The platforms the mod browser (search, version lists, dependency closure)
 * handles. GitHub has no search, so it stays add-by-link only. One-click
 * updates (mods.controller.ts update()) still narrow this to Modrinth and
 * CurseForge — see MODS_NOTES.md.
 */
export type BrowsablePlatform = Extract<
  ModPlatform,
  'modrinth' | 'curseforge' | 'hangar' | 'spiget'
>;

/** The registries that can identify a jar by its hash (JarIdentifierService). */
export type HashLookupPlatform = Extract<
  ModPlatform,
  'modrinth' | 'curseforge'
>;

export type {
  BlockedDownload,
  BlockedDownloadReason,
} from '../../../shared/types/mods';

/**
 * A registry-published checksum for a not-yet-downloaded file, carried
 * alongside a download URL so LibraryService can verify the bytes it
 * receives actually match what the registry advertised before trusting
 * the file. Algorithm is whatever the source natively publishes — never
 * invented per callsite.
 */
export interface ExpectedHash {
  algorithm: 'sha1' | 'sha256' | 'sha512' | 'md5';
  hex: string;
}

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
  /** Every MC version the project has a build for. */
  gameVersions: string[];
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
  // algo: 1 = Sha1, 2 = Md5 (CurseForge's own enum — see cfFileHashToExpectedHash).
  hashes: { value: string; algo: number }[];
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

/** A Modrinth version from a hash lookup, which also names its project. */
export interface ModrinthVersionWithProject extends ModrinthVersion {
  project_id: string;
}

/** Resolved-URL/slug result shared by CurseforgeApiService.resolveUrl. */
export interface CurseforgeResolved extends CurseforgeMod {
  fileId: number | null;
}

/** A Hangar (hangar.papermc.io) project, normalized from the raw API response. */
export interface HangarProject {
  slug: string;
  owner: string;
  name: string;
  description: string;
  iconUrl: string | null;
  downloads: number;
}

/**
 * One Hangar version's PAPER-platform build. `downloadUrl` is null when the
 * version only links out to an external site (`external: true`, `externalUrl`
 * set) — Hangar publishes `sha256` only for files it hosts itself.
 */
export interface HangarVersion {
  /** Hangar version names are unique per project and address its version endpoints. */
  name: string;
  datePublished: string | null;
  versionType: 'release' | 'beta' | 'alpha';
  channel: string | null;
  gameVersions: string[];
  downloadUrl: string | null;
  externalUrl: string | null;
  external: boolean;
  filename: string | null;
  sizeBytes: number | null;
  sha256: string | null;
}

/** Resolved-URL/slug result for HangarApiService.resolveUrl. */
export interface HangarResolved extends HangarProject {
  versionName: string | null;
}

/** A SpigotMC resource (via the Spiget API), normalized from the raw response. */
export interface SpigetResource {
  resourceId: number;
  name: string;
  tag: string;
  downloads: number;
  iconUrl: string | null;
  testedVersions: string[];
  /** Hosted off-site — Spiget can't proxy the file, so it's a manual download. */
  external: boolean;
  /** Paid resource — never downloadable without the buyer's SpigotMC session. */
  premium: boolean;
  /** Where an `external` resource is actually hosted (may be a page, not a file). */
  externalUrl: string | null;
  pageUrl: string;
}

/** One SpigotMC resource version. Spiget carries no per-version MC tags or hashes. */
export interface SpigetVersion {
  versionId: string;
  name: string;
  datePublished: string | null;
}

/** A SpigotMC resource id (and optional pinned version) parsed from pasted input. */
export interface SpigetResourceRef {
  resourceId: number;
  versionId: string | null;
}

/** Resolved-URL/id result for SpigetApiService.resolveUrl. */
export interface SpigetResolved extends SpigetResource {
  versionId: string | null;
}

/** A GitHub repository, normalized from GET /repos/{owner}/{repo}. */
export interface GithubRepo {
  /** Canonical `owner/repo` (GitHub's own `full_name` casing). */
  repo: string;
  name: string;
  description: string;
  iconUrl: string | null;
}

/** A `.jar` asset attached to a GitHub release. */
export interface GithubReleaseAsset {
  name: string;
  size: number;
  downloadUrl: string;
  /** From the asset's `digest` field (`sha256:<hex>`); null on assets that predate it. */
  sha256: string | null;
}

/** A published (non-draft) GitHub release and its jar assets. */
export interface GithubRelease {
  tag: string;
  name: string;
  prerelease: boolean;
  publishedAt: string | null;
  htmlUrl: string;
  assets: GithubReleaseAsset[];
}

/** An `owner/repo` (plus optional release tag / asset name) parsed from pasted input. */
export interface GithubRepoRef {
  repo: string;
  tag: string | null;
  asset: string | null;
}

/** Resolved-URL/ref result for GithubReleasesApiService.resolveUrl. */
export interface GithubResolved extends GithubRepo {
  tag: string | null;
  asset: string | null;
}

/** Parsed `pack.toml`(https://packwiz.infra.link/reference/pack-format/pack-toml/) — fields this codebase reads. */
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

/** One exact match from CurseForge's fingerprint lookup (POST /v1/fingerprints/{gameId}). */
export interface CurseforgeFingerprintMatch {
  modId: number;
  /** The fingerprint CurseForge stored for this file (see curseforge-fingerprint.ts). */
  fingerprint: number;
  file: CurseforgeFile;
}

/** Mod loaders / plugin platforms a jar's own manifest can declare. */
export type JarManifestLoader =
  'fabric' | 'quilt' | 'forge' | 'neoforge' | 'paper' | 'bukkit';

/**
 * What a jar says about itself in its own manifest (fabric.mod.json,
 * mods.toml, mcmod.info, plugin.yml, ...). Best effort: every field but
 * `manifest`/`kind`/`loaders` can be null when the manifest leaves it out or
 * only has a build-time placeholder like `${version}`.
 */
export interface JarMetadata {
  /** The manifest entry the fields came from, e.g. `fabric.mod.json`. */
  manifest: string;
  kind: 'mod' | 'plugin';
  /** The loader of `manifest` first, then any other loader the jar also has a manifest for. */
  loaders: JarManifestLoader[];
  modId: string | null;
  name: string | null;
  version: string | null;
  /** Minecraft requirement as written (often a range). Informational only. */
  mcConstraint: string | null;
}

/** A jar to identify. `filename` is used for display and the `unknown` fallback only. */
export interface JarInput {
  filename: string;
  data: Buffer;
}

/** Which layer of JarIdentifierService's chain identified a jar. */
export type JarIdentitySource =
  'modrinth' | 'curseforge' | 'metadata' | 'unknown';

/**
 * A jar after JarIdentifierService's chain. `platform`, `projectId`,
 * `versionId` and `slug` are set only for registry matches. CurseForge ids are
 * stringified so both registries share one shape, as in library_files.
 */
export interface IdentifiedJar {
  filename: string;
  size: number;
  sha1: string;
  sha256: string;
  /** CurseForge fingerprint (murmur2 over the whitespace-stripped bytes). */
  fingerprint: number;
  source: JarIdentitySource;
  platform: HashLookupPlatform | null;
  projectId: string | null;
  versionId: string | null;
  slug: string | null;
  /** Always set: registry title, else manifest name, else the filename minus `.jar`. */
  name: string;
  version: string | null;
  iconUrl: string | null;
  loaders: string[];
  /** Exact Minecraft versions the registry lists for the file (registry matches only). */
  mcVersions: string[];
  /** Minecraft requirement from the jar's own manifest (`metadata` matches only). */
  mcConstraint: string | null;
  /** null when nothing identified the jar. */
  kind: 'mod' | 'plugin' | null;
}
