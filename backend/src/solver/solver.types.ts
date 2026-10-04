export type SolverPlatform = 'modrinth' | 'curseforge';

/** One project the caller wants solved: which registry, and its slug/id there. */
export interface SolveRef {
  platform: SolverPlatform;
  ref: string;
}

export interface LoaderDef {
  id: string;
  label: string;
  type: string;
  tags: string[];
}

export interface PairMeta {
  loader: string;
  loaderLabel: string;
  type: string;
  mcVersion: string;
}

export interface SolveBest extends PairMeta {
  coverage: 'all';
}

export interface SolvePartialDropped {
  platform: SolverPlatform;
  ref: string;
  slug: string;
  title: string;
  supportedVersions: string[];
}

export interface SolvePartial {
  loader: string;
  loaderLabel: string;
  type: string;
  mcVersion: string;
  coveredCount: number;
  total: number;
  /** `platform:slug` keys, matching `SolvePerProject.key`. */
  coveredKeys: string[];
  dropped: SolvePartialDropped[];
}

export interface SolvePerProject {
  platform: SolverPlatform;
  /** `platform:slug` — unique across registries (slugs can collide). */
  key: string;
  ref: string;
  slug: string;
  title: string;
  iconUrl: string | null;
  supported: boolean;
  bestOwnVersions: { loader: string | null; versions: string[] };
}

export interface SolveResult {
  best: SolveBest | null;
  alternatives: PairMeta[];
  perProject: SolvePerProject[];
  partial: SolvePartial | null;
}
