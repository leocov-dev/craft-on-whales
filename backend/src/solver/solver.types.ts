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
  coveredSlugs: string[];
  dropped: SolvePartialDropped[];
}

export interface SolvePerProject {
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
