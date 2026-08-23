/** `GET /api/packs/search` row shape. */
export interface PackSearchResult {
  platform: 'modrinth' | 'curseforge';
  ref: string;
  name: string;
  iconUrl: string | null;
  downloads: number;
  description: string;
}

export type PackPlatform = 'curseforge' | 'modrinth' | 'ftb' | 'gtnh' | 'packwiz';

/**
 * One mod entry in a packwiz pack's `GET /api/packs/details` `mods` array
 * (uses `filename`, `side`, `updatePlatform` — from the pack's own TOML), or
 * the installed-pack `GET /api/servers/:id/pack/mods` `mods` array (uses
 * `file`, `kind`, `version`, `size`, `enabled` — from the on-disk scan).
 */
export interface PackModInfo {
  name: string;
  filename?: string;
  file?: string;
  side?: 'both' | 'client' | 'server';
  updatePlatform?: 'curseforge' | 'modrinth' | null;
  kind?: string;
  version?: string | null;
  size?: number;
  enabled?: boolean;
}

/** `GET /api/packs/details` response's `pack` shape. */
export interface PackDetails {
  platform: PackPlatform;
  ref: string;
  projectId: string;
  name: string;
  iconUrl: string | null;
  author: string | null;
  downloads: number | null;
  description: string;
  mcVersion: string | null;
  loaders: string[] | null;
  defaultVersionId: string;
  versions: { id: string; name: string; type: string; date: string | null }[];
  mods: PackModInfo[] | null;
  installed: { serverId: string; serverName: string; versionId: string; versionName: string } | null;
}
