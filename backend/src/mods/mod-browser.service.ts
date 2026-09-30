import { Injectable } from '@nestjs/common';
import { ModrinthApiService } from './modrinth-api.service';
import { CurseforgeApiService } from './curseforge-api.service';
import { HangarApiService } from './hangar-api.service';
import { SpigetApiService } from './spiget-api.service';
import type {
  BrowsablePlatform,
  ModrinthVersion,
  CurseforgeFile,
  HangarVersion,
  SpigetResource,
  SpigetVersion,
} from './mods.types';

// Backend for the "From mods" wizard browser. Three concerns, four platforms
// (Modrinth, CurseForge, Hangar, SpigotMC via Spiget):
//   search()   — find mods for a loader + MC version on one platform
//   versions() — a mod's builds filtered to that loader + MC, newest first
//   resolveDependencies() — the required-dependency closure of a selection,
//                           so the wizard can show "added as dependency" rows
// A dependency stays on the same platform as its parent (Modrinth project ids
// and CurseForge mod ids never cross), so no cross-platform mapping is needed.
// Hangar and Spiget publish no machine-readable dependencies, so their
// closure is always empty.

const MAX_DEPS = 50; // safety cap on the resolved-dependency closure
const MAX_ITER = 300; // recursion guard
const DEP_BATCH_SIZE = 5; // concurrency cap per BFS level in resolveDependencies()

/** Every platform the browse routes accept (zod enums in the controller). */
export const BROWSABLE_PLATFORMS = [
  'modrinth',
  'curseforge',
  'hangar',
  'spiget',
] as const satisfies readonly BrowsablePlatform[];

/** The one wizard loader that runs plugins (it creates a PAPER server). */
export const PLUGIN_LOADER = 'paper';

/**
 * Hangar and SpigotMC only host Paper/Spigot plugins. Asking one of them for
 * a Fabric/Forge/... build can never produce something the server loads, so
 * it's answered with nothing rather than a list of unusable plugins.
 */
const PLUGIN_ONLY_PLATFORMS: ReadonlySet<BrowsablePlatform> = new Set([
  'hangar',
  'spiget',
]);

/** Whether `platform` can have builds for `loader` (no loader = unfiltered). */
export function platformServesLoader(
  platform: BrowsablePlatform,
  loader: string | undefined,
): boolean {
  return (
    !loader || !PLUGIN_ONLY_PLATFORMS.has(platform) || loader === PLUGIN_LOADER
  );
}

function normMc(mc: string | null | undefined): string | undefined {
  const v = String(mc || '').trim();
  return v && v !== 'LATEST' && v !== 'SNAPSHOT' ? v : undefined;
}

/** A single unified search result row, same shape for every platform. */
export interface ModSearchHit {
  platform: BrowsablePlatform;
  /**
   * What the other routes take back as `ref`: a Modrinth/CurseForge slug, a
   * Hangar `owner/slug`, a SpigotMC resource id.
   */
  ref: string;
  projectId: string;
  name: string;
  description: string;
  iconUrl: string | null;
  downloads: number;
}

export interface ModBrowserSearchParams {
  query: string | null | undefined;
  platform?: BrowsablePlatform;
  loader?: string;
  mc?: string;
  limit?: number;
}

interface ModMeta {
  ref: string;
  projectId: string;
  name: string;
  iconUrl: string | null;
}

/** A mod build/version, normalized to a shared shape across platforms. */
export interface ModVersion {
  versionId: string;
  name: string;
  versionNumber: string;
  datePublished: string | null;
  versionType: string;
  /**
   * MC versions the build declares. For SpigotMC this is the resource's
   * author-maintained `testedVersions` (Spiget has no per-version data).
   */
  gameVersions: string[];
  requiredDeps: string[];
  /**
   * False when the panel can't download the build itself and install would
   * answer 409 BlockedDownload: a CurseForge file whose author forbids API
   * download, a Hangar build hosted off-site, a premium or external SpigotMC
   * resource. Unset on Modrinth (always downloadable).
   */
  downloadable?: boolean;
}

export interface ModBrowserVersionsParams {
  platform: BrowsablePlatform;
  ref: string;
  loader?: string;
  mc?: string;
  limit?: number;
}

/** One selection entry the wizard passes in to resolveDependencies(). */
export interface DepSelectionEntry {
  platform: BrowsablePlatform;
  ref: string;
  versionId?: string | null;
}

/** One resolved dependency, editable in the wizard before install. */
export interface ResolvedDep {
  platform: BrowsablePlatform;
  ref: string;
  projectId: string;
  name: string;
  iconUrl: string | null;
  versions: ModVersion[];
  versionId: string;
}

interface QueueNode {
  platform: BrowsablePlatform;
  projectId: string;
}

@Injectable()
export class ModBrowserService {
  constructor(
    private readonly modrinth: ModrinthApiService,
    private readonly curseforge: CurseforgeApiService,
    private readonly hangar: HangarApiService,
    private readonly spiget: SpigetApiService,
  ) {}

  /**
   * Unified search on one platform. `loader: 'paper'` searches plugins on
   * Modrinth and CurseForge; Hangar and Spiget answer nothing for a mod
   * loader (see platformServesLoader).
   */
  async search({
    query,
    platform = 'modrinth',
    loader,
    mc,
    limit = 20,
  }: ModBrowserSearchParams): Promise<ModSearchHit[]> {
    const q = String(query || '').trim();
    if (!q) return [];
    if (!platformServesLoader(platform, loader)) return [];
    const mcVersion = normMc(mc);
    const plugin = loader === PLUGIN_LOADER;
    switch (platform) {
      case 'curseforge': {
        const hits = await this.curseforge.search({
          query: q,
          kind: plugin ? 'plugin' : 'mod',
          // The Bukkit Plugins class has no mod-loader type to filter on.
          loader: plugin ? undefined : loader,
          mcVersion,
          limit,
        });
        return hits.map((m) => ({
          platform: 'curseforge' as const,
          ref: m.slug,
          projectId: String(m.modId),
          name: m.name,
          description: m.summary || '',
          iconUrl: m.iconUrl || null,
          downloads: m.downloads || 0,
        }));
      }
      case 'hangar': {
        // Hangar filters by platform (always PAPER) and MC version itself.
        const hits = await this.hangar.search({ query: q, mcVersion, limit });
        return hits.map((p) => ({
          platform: 'hangar' as const,
          // owner/slug, because a Hangar page URL needs both (see refToUrl).
          ref: `${p.owner}/${p.slug}`,
          projectId: p.slug,
          name: p.name,
          description: p.description,
          iconUrl: p.iconUrl,
          downloads: p.downloads,
        }));
      }
      case 'spiget': {
        // Spiget has no MC-version filter, and its resource-level
        // testedVersions is too stale to filter on (see MODS_NOTES.md).
        const hits = await this.spiget.search({ query: q, limit });
        return hits.map((r) => ({
          platform: 'spiget' as const,
          ref: String(r.resourceId),
          projectId: String(r.resourceId),
          name: r.name,
          description: r.tag,
          iconUrl: r.iconUrl,
          downloads: r.downloads,
        }));
      }
      case 'modrinth': {
        const hits = await this.modrinth.search({
          query: q,
          // Modrinth's plugin search matches the plugin loaders by itself.
          kind: plugin ? 'plugin' : 'mod',
          loader,
          mcVersion,
          limit,
        });
        return hits.map((h) => ({
          platform: 'modrinth' as const,
          ref: h.slug,
          projectId: h.projectId,
          name: h.title,
          description: h.description || '',
          iconUrl: h.iconUrl || null,
          downloads: h.downloads || 0,
        }));
      }
    }
  }

  /** {ref, projectId, name, iconUrl} for a mod given a ref or platform id. */
  async metaFor(
    platform: BrowsablePlatform,
    refOrId: string,
  ): Promise<ModMeta> {
    switch (platform) {
      case 'curseforge': {
        const mod = /^\d+$/.test(String(refOrId))
          ? await this.curseforge.getMod(Number(refOrId))
          : await this.curseforge.resolveUrl(String(refOrId));
        return {
          ref: mod.slug,
          projectId: String(mod.modId),
          name: mod.name,
          iconUrl: mod.iconUrl || null,
        };
      }
      case 'hangar': {
        // Takes owner/slug or a bare slug; the ref comes back as owner/slug.
        const p = await this.hangar.resolveUrl(refOrId);
        return {
          ref: `${p.owner}/${p.slug}`,
          projectId: p.slug,
          name: p.name,
          iconUrl: p.iconUrl,
        };
      }
      case 'spiget': {
        const r = await this.spiget.resolveUrl(refOrId);
        return {
          ref: String(r.resourceId),
          projectId: String(r.resourceId),
          name: r.name,
          iconUrl: r.iconUrl,
        };
      }
      case 'modrinth': {
        const p = await this.modrinth.getProject(refOrId);
        return {
          ref: p.slug,
          projectId: p.id,
          name: p.title,
          iconUrl: p.icon_url || null,
        };
      }
    }
  }

  /** Normalize one Modrinth version to the shared shape (+ required-dep project ids). */
  private normModrinthVersion(v: ModrinthVersion): ModVersion {
    return {
      versionId: v.id,
      name: v.name || v.version_number,
      versionNumber: v.version_number,
      datePublished: v.date_published || null,
      versionType: v.version_type || 'release',
      gameVersions: v.game_versions || [],
      requiredDeps: (v.dependencies || [])
        .filter((d) => d.dependency_type === 'required' && d.project_id)
        .map((d) => String(d.project_id)),
    };
  }

  /** Normalize one CurseForge file to the shared shape (relationType 3 = required). */
  private normCurseforgeFile(f: CurseforgeFile): ModVersion {
    return {
      versionId: String(f.fileId),
      name: f.name || f.fileName,
      versionNumber: f.name || f.fileName,
      datePublished: f.fileDate || null,
      versionType: f.releaseType || 'release',
      gameVersions: f.gameVersions || [],
      requiredDeps: (f.dependencies || [])
        .filter((d) => d.relation === 3)
        .map((d) => String(d.modId)),
      downloadable: Boolean(f.downloadUrl), // CF authors can forbid API download
    };
  }

  /** Normalize one Hangar PAPER build. Version names are unique per project. */
  private normHangarVersion(v: HangarVersion): ModVersion {
    return {
      versionId: v.name,
      name: v.name,
      versionNumber: v.name,
      datePublished: v.datePublished,
      versionType: v.versionType,
      gameVersions: v.gameVersions,
      requiredDeps: [],
      downloadable: v.downloadUrl !== null, // external-only builds are a 409
    };
  }

  /**
   * Normalize one Spiget version. Spiget has no per-version MC data or
   * release channel, so the resource's testedVersions stands in; a premium
   * or external resource can't be proxied on any version.
   */
  private normSpigetVersion(
    v: SpigetVersion,
    resource: SpigetResource,
  ): ModVersion {
    return {
      versionId: v.versionId,
      name: v.name,
      versionNumber: v.name,
      datePublished: v.datePublished,
      versionType: 'release',
      gameVersions: resource.testedVersions,
      requiredDeps: [],
      downloadable: !resource.premium && !resource.external,
    };
  }

  /** A mod's builds for a loader + MC version, newest first. */
  async versions({
    platform,
    ref,
    loader,
    mc,
    limit = 30,
  }: ModBrowserVersionsParams): Promise<ModVersion[]> {
    if (!platformServesLoader(platform, loader)) return [];
    const mcVersion = normMc(mc);
    switch (platform) {
      case 'curseforge': {
        const meta = await this.metaFor('curseforge', ref);
        const files = await this.curseforge.getFiles(Number(meta.projectId), {
          mcVersion,
          loader,
        });
        return files.slice(0, limit).map((f) => this.normCurseforgeFile(f));
      }
      case 'hangar': {
        const meta = await this.metaFor('hangar', ref);
        // getVersions drops builds tagged for other MC versions itself.
        const list = await this.hangar.getVersions(meta.projectId, {
          mcVersion,
          limit,
        });
        return list.slice(0, limit).map((v) => this.normHangarVersion(v));
      }
      case 'spiget': {
        const resource = await this.spiget.resolveUrl(ref);
        const list = await this.spiget.getVersions(resource.resourceId, {
          limit,
        });
        return list
          .slice(0, limit)
          .map((v) => this.normSpigetVersion(v, resource));
      }
      case 'modrinth': {
        const list = await this.modrinth.getVersions(ref, {
          loader,
          mcVersion,
        });
        return list.slice(0, limit).map((v) => this.normModrinthVersion(v));
      }
    }
  }

  private depKey(platform: BrowsablePlatform, projectId: string): string {
    return `${platform}:${projectId}`;
  }

  /** Required-dependency project ids of ONE build (same platform as its parent). */
  private async requiredDepsOfVersion(
    platform: BrowsablePlatform,
    projectId: string,
    versionId: string,
  ): Promise<string[]> {
    try {
      switch (platform) {
        case 'curseforge': {
          const file = await this.curseforge.getFile(
            Number(projectId),
            Number(versionId),
          );
          return this.normCurseforgeFile(file).requiredDeps;
        }
        case 'hangar':
        case 'spiget':
          return []; // no machine-readable dependencies published
        case 'modrinth': {
          const v = await this.modrinth.getVersion(versionId);
          return this.normModrinthVersion(v).requiredDeps;
        }
      }
    } catch {
      return []; // a missing/removed build shouldn't break the whole resolve
    }
  }

  /**
   * Resolve the recursive required-dependency closure of a selection.
   * deps excludes anything already in the selection; each carries its own
   * version list + default pick so the wizard row is immediately editable.
   */
  async resolveDependencies({
    loader,
    mc,
    selection = [],
  }: {
    loader?: string;
    mc?: string;
    selection?: DepSelectionEntry[];
  }): Promise<{ deps: ResolvedDep[]; warnings: string[] }> {
    const have = new Set<string>(); // projects already covered (selection + resolved deps)
    const warnings: string[] = [];
    const deps: ResolvedDep[] = [];
    const queue: QueueNode[] = [];

    // Seed: mark every selected project as covered, then enqueue its required deps.
    for (const item of selection) {
      if (!item || !item.ref) continue;
      let meta: ModMeta;
      try {
        meta = await this.metaFor(item.platform, item.ref);
      } catch {
        continue;
      }
      have.add(this.depKey(item.platform, meta.projectId));
      const reqs = item.versionId
        ? await this.requiredDepsOfVersion(
            item.platform,
            meta.projectId,
            item.versionId,
          )
        : [];
      for (const pid of reqs)
        queue.push({ platform: item.platform, projectId: pid });
    }

    // Processed a batch (BFS "level") at a time instead of one node per
    // network round trip — siblings already in the queue don't depend on
    // each other, so their metaFor()/versions() lookups can run concurrently;
    // only newly-discovered deps (pushed after a batch resolves) have to
    // wait for their parent's batch to finish.
    let iter = 0;
    while (queue.length && iter < MAX_ITER && deps.length < MAX_DEPS) {
      const batch: QueueNode[] = [];
      while (
        queue.length &&
        batch.length < DEP_BATCH_SIZE &&
        iter + batch.length < MAX_ITER
      ) {
        const node = queue.shift()!;
        const k = this.depKey(node.platform, node.projectId);
        if (have.has(k)) continue;
        have.add(k);
        batch.push(node);
      }
      if (!batch.length) continue;
      iter += batch.length;

      const resolved = await Promise.all(
        batch.map(async (node) => {
          let meta: ModMeta;
          try {
            meta = await this.metaFor(node.platform, node.projectId);
          } catch {
            return null; // unresolvable id — skip quietly
          }
          let vers: ModVersion[] = [];
          try {
            vers = await this.versions({
              platform: node.platform,
              ref: meta.ref,
              loader,
              mc,
            });
          } catch {
            vers = [];
          }
          return { node, meta, vers };
        }),
      );

      for (const r of resolved) {
        if (!r || deps.length >= MAX_DEPS) continue;
        const { node, meta, vers } = r;
        if (!vers.length) {
          warnings.push(
            `${meta.name} has no ${loader}${mc ? ` ${mc}` : ''} build — skipped`,
          );
          continue;
        }
        const chosen = vers[0]!; // newest compatible build
        deps.push({
          platform: node.platform,
          ref: meta.ref,
          projectId: meta.projectId,
          name: meta.name,
          iconUrl: meta.iconUrl,
          versions: vers,
          versionId: chosen.versionId,
        });
        // Recurse into this dependency's own required deps.
        for (const pid of chosen.requiredDeps)
          queue.push({ platform: node.platform, projectId: pid });
      }
    }

    return { deps, warnings };
  }
}
