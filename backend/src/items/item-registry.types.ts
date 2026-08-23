/** One item/block entry in the built registry. */
export interface RegistryItem {
  id: string;
  name: string;
  mod: string;
  kind: 'item' | 'block';
}

/** One mod's summary row, for the mod filter dropdown. */
export interface RegistryModSummary {
  id: string;
  name: string;
  count: number;
}

/** The full built/cached registry for one server. */
export interface Registry {
  items: RegistryItem[];
  mods: RegistryModSummary[];
  builtAt: number;
  buildMs: number;
  fingerprint: string;
  vanillaJar: string | null;
  jarCount: number;
}

/** A raw parsed lang-file entry, before merging into the registry. */
export interface LangEntry {
  id: string;
  name: string;
  kind: 'item' | 'block';
  ns: string;
}

export interface McDataItem {
  name: string;
  displayName: string;
}

export interface McDataBlock {
  name: string;
}

export interface SearchParams {
  q?: string;
  mod?: string;
  kind?: 'item' | 'block' | '';
  limit?: number;
  offset?: number;
}
