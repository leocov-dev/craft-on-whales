/**
 * Loaders a server also accepts builds of, beyond its own. Quilt Loader runs
 * Fabric mods, but most projects only tag their builds "fabric", so without
 * the fallback a Quilt server sees a near-empty catalog. The reverse does not
 * hold (Fabric can't run Quilt-only mods). Add a row here to extend.
 */
const LOADER_FALLBACKS: Readonly<Record<string, readonly string[]>> = {
  quilt: ['fabric'],
};

/** The loader tags a server accepts, its own first, then its fallbacks. */
export function acceptedLoaders(loader: string): string[] {
  const own = loader.toLowerCase();
  return [own, ...(LOADER_FALLBACKS[own] ?? [])];
}

/** Whether a build tagged `tags` runs on a `loader` server. */
export function loaderAccepts(
  loader: string,
  tags: readonly string[],
): boolean {
  const lowered = tags.map((t) => t.toLowerCase());
  return acceptedLoaders(loader).some((l) => lowered.includes(l));
}

/**
 * Reorder newest-first `builds` so ones tagged with the server's own loader
 * come before fallback-tagged ones, keeping the order inside each group. A
 * Quilt server therefore takes a quilt build over a newer fabric one whenever
 * a quilt build exists. A no-op without a loader.
 */
export function preferOwnLoader<T>(
  builds: readonly T[],
  loader: string | undefined,
  tagsOf: (build: T) => readonly string[] | undefined,
): T[] {
  if (!loader) return [...builds];
  const own = loader.toLowerCase();
  const isOwn = (b: T) =>
    (tagsOf(b) ?? []).some((t) => t.toLowerCase() === own);
  return [...builds.filter(isOwn), ...builds.filter((b) => !isOwn(b))];
}
