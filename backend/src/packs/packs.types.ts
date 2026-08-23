export type PackPlatform = 'curseforge' | 'modrinth' | 'ftb' | 'gtnh';

export interface PackVersionOption {
  id: string;
  name: string;
  type: string;
  date: string | null;
  maxJavaVersion?: number | null;
}

/** Resolve-a-pack-reference result: enough to install/pin + show a version picker. */
export interface ResolvedPack {
  platform: PackPlatform;
  projectRef: string;
  projectId: string;
  projectName: string;
  iconUrl?: string | null;
  versionId: string;
  versionName: string;
  mcVersion: string | null;
  loaders?: string[];
  maxJavaVersion?: number | null;
  channel?: 'beta' | 'stable';
  javaTag?: string;
  changelogUrl?: string | null;
  allVersions: PackVersionOption[];
}

export interface ResolvePackOptions {
  versionId?: string | null;
  mcVersion?: string;
  includeBeta?: boolean;
}

export interface PackLatestInfo {
  current: { id: string | null; name: string | null };
  latest: { id: string; name: string };
  updateAvailable: boolean;
  projectName: string | null;
  projectRef: string | null;
  platform: string;
  changelogUrl?: string | null;
}
