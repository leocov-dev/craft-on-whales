import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ModrinthApiService } from '../mods/modrinth-api.service';
import {
  CurseforgeApiService,
  CLASS_MODPACKS,
  CLASS_PLUGINS,
} from '../mods/curseforge-api.service';
import { JavaMatrixService } from '../servers/java-matrix.service';
import type { CurseforgeFile, ModrinthVersion } from '../mods/mods.types';
import type {
  LoaderDef,
  PairMeta,
  SolveBest,
  SolveRef,
  SolvePartial,
  SolvePerProject,
  SolveResult,
  SolverPlatform,
} from './solver.types';

const MAX_PROJECTS = 25;
const PLUGIN_LOADER = 'paper';
const PLATFORM_LABEL: Record<SolverPlatform, string> = {
  modrinth: 'Modrinth',
  curseforge: 'CurseForge',
};

// Panel loader buckets, in preference order (used as the tiebreaker after
// "newest MC version wins"). Each bucket lists the Modrinth loader tags that
// count as compatible with it — plugin projects tag bukkit/spigot builds that
// Paper runs fine.
const LOADERS: LoaderDef[] = [
  { id: 'fabric', label: 'Fabric', type: 'FABRIC', tags: ['fabric'] },
  { id: 'neoforge', label: 'NeoForge', type: 'NEOFORGE', tags: ['neoforge'] },
  { id: 'forge', label: 'Forge', type: 'FORGE', tags: ['forge'] },
  { id: 'quilt', label: 'Quilt', type: 'QUILT', tags: ['quilt'] },
  {
    id: 'paper',
    label: 'Paper',
    type: 'PAPER',
    tags: ['paper', 'purpur', 'spigot', 'bukkit'],
  },
];

const LOADER_RANK = new Map(LOADERS.map((l, i) => [l.id, i]));

type LoaderMap = Map<string, Set<string>>;

/** Plain release versions only ("1.21.4"). parseVersion() matches prefixes, so
 *  the regex also rejects snapshots/RCs like "26.2-rc-1" or "1.21.2-pre1". */
const isReleaseVersion = (gv: string, parse: (v: string) => unknown): boolean =>
  /^\d+\.\d+(\.\d+)?$/.test(gv) && Boolean(parse(gv));

interface SolveProject {
  platform: SolveRef['platform'];
  /** `platform:slug` */
  key: string;
  ref: string;
  slug: string;
  title: string;
  iconUrl: string | null;
  loaderMap: LoaderMap;
}

/** Compatibility Solver — "pick mods first". Given a list of Modrinth and/or
 *  CurseForge projects, fetch every project's version list (cached client, sequential
 *  — never hammers the API), build a loader → supported-MC-versions map per
 *  project, and find the newest (loader, MC version) pair that EVERY project
 *  supports. When no pair covers all projects, return the best partial pair
 *  plus which projects drop. */
@Injectable()
export class SolverService {
  static readonly LOADERS = LOADERS;
  static readonly MAX_PROJECTS = MAX_PROJECTS;

  constructor(
    private readonly modrinth: ModrinthApiService,
    private readonly curseforge: CurseforgeApiService,
    private readonly javaMatrix: JavaMatrixService,
  ) {}

  /** Newest-first comparator for release-style MC versions ("1.21.4"). */
  compareMcDesc(a: string, b: string): number {
    const va = this.javaMatrix.parseVersion(a);
    const vb = this.javaMatrix.parseVersion(b);
    if (!va || !vb) return 0; // non-parseable never reaches candidate ranking
    return vb.major - va.major || vb.minor - va.minor || vb.patch - va.patch;
  }

  private isRelease(gv: string): boolean {
    return isReleaseVersion(gv, (v) => this.javaMatrix.parseVersion(v));
  }

  /** loader id → Set of release-style MC versions, from a project's version list. */
  buildLoaderMap(versions: ModrinthVersion[]): LoaderMap {
    const map: LoaderMap = new Map(
      LOADERS.map((l) => [l.id, new Set<string>()]),
    );
    for (const v of versions) {
      if (v.version_type !== 'release' && v.version_type !== 'beta') continue; // skip alphas
      const vLoaders = (v.loaders || []).map((x) => String(x).toLowerCase());
      for (const loader of LOADERS) {
        if (!loader.tags.some((t) => vLoaders.includes(t))) continue;
        for (const gv of v.game_versions || []) {
          if (this.isRelease(gv)) map.get(loader.id)?.add(gv);
        }
      }
    }
    return map;
  }

  /**
   * loader id → Set of release-style MC versions, from a CurseForge project's
   * file history. CurseForge mixes MC versions and loader names ("Fabric",
   * "NeoForge") in one `gameVersions` list. Bukkit Plugins files carry no
   * loader tag at all, so a plugin project counts as Paper.
   */
  buildCurseforgeLoaderMap(
    files: CurseforgeFile[],
    classId: number,
  ): LoaderMap {
    const map: LoaderMap = new Map(
      LOADERS.map((l) => [l.id, new Set<string>()]),
    );
    const isPlugin = classId === CLASS_PLUGINS;
    for (const f of files) {
      if (f.releaseType === 'alpha') continue; // same policy as Modrinth
      const mcVersions: string[] = [];
      const tags: string[] = [];
      for (const gv of f.gameVersions) {
        if (this.isRelease(gv)) mcVersions.push(gv);
        else tags.push(gv.toLowerCase());
      }
      const buckets = LOADERS.filter((l) =>
        isPlugin
          ? l.id === PLUGIN_LOADER
          : l.id !== PLUGIN_LOADER && l.tags.some((t) => tags.includes(t)),
      );
      for (const b of buckets)
        for (const gv of mcVersions) map.get(b.id)?.add(gv);
    }
    return map;
  }

  pairMeta(loaderId: string, mcVersion: string): PairMeta {
    const loader = LOADERS.find((l) => l.id === loaderId);
    if (!loader) throw new Error(`Unknown loader id: ${loaderId}`);
    return {
      loader: loaderId,
      loaderLabel: loader.label,
      type: loader.type,
      mcVersion,
    };
  }

  /** Newest-first, then loader preference. */
  private comparePairs(a: PairMeta, b: PairMeta): number {
    return (
      this.compareMcDesc(a.mcVersion, b.mcVersion) ||
      (LOADER_RANK.get(a.loader) ?? 0) - (LOADER_RANK.get(b.loader) ?? 0)
    );
  }

  /** Fetch one project's metadata + version history and map loader -> MC versions. */
  private async loadProject({
    platform,
    ref,
  }: SolveRef): Promise<SolveProject> {
    try {
      if (platform === 'curseforge') {
        const mod = await this.curseforge.resolveUrl(ref);
        if (mod.classId === CLASS_MODPACKS)
          throw new BadRequestException(
            `"${ref}" is a CurseForge modpack, not a mod or plugin`,
          );
        const files = await this.curseforge.getAllFiles(mod.modId);
        return {
          platform,
          key: `${platform}:${mod.slug}`,
          ref,
          slug: mod.slug,
          title: mod.name,
          iconUrl: mod.iconUrl,
          loaderMap: this.buildCurseforgeLoaderMap(files, mod.classId),
        };
      }
      const meta = await this.modrinth.getProject(ref);
      const versions = await this.modrinth.getVersions(ref); // ALL versions, unfiltered
      return {
        platform,
        key: `${platform}:${meta.slug}`,
        ref,
        slug: meta.slug,
        title: meta.title,
        iconUrl: meta.icon_url || null,
        loaderMap: this.buildLoaderMap(versions),
      };
    } catch (err: unknown) {
      if (
        err instanceof NotFoundException ||
        (err as { status?: number }).status === 404
      )
        throw new NotFoundException(
          `"${ref}" was not found on ${PLATFORM_LABEL[platform]}`,
        );
      throw err;
    }
  }

  /**
   * Solve compatibility for a set of projects.
   * @param projectRefs 1..25 projects; a bare string means a Modrinth slug/id
   */
  async solve(projectRefs: (string | SolveRef)[]): Promise<SolveResult> {
    const seen = new Set<string>();
    const refs: SolveRef[] = [];
    for (const r of projectRefs || []) {
      const entry: SolveRef =
        typeof r === 'string' ? { platform: 'modrinth', ref: r } : r;
      const ref = String(entry.ref).trim();
      if (!ref) continue;
      const key = `${entry.platform}:${ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ platform: entry.platform, ref });
    }
    if (!refs.length)
      throw new BadRequestException('Pick at least one mod to solve for');
    if (refs.length > MAX_PROJECTS)
      throw new BadRequestException(`At most ${MAX_PROJECTS} mods per solve`);

    // Sequential fetches through the cached clients — never hammers the APIs.
    const projects: SolveProject[] = [];
    // De-dupe on the resolved key: "10" and "jei", or a Modrinth id and its
    // slug, are the same project.
    const loaded = new Set<string>();
    for (const ref of refs) {
      const project = await this.loadProject(ref);
      if (loaded.has(project.key)) continue;
      loaded.add(project.key);
      projects.push(project);
    }

    // Full-coverage candidates: for each loader, intersect every project's
    // supported MC versions on that loader.
    const fullPairs: PairMeta[] = [];
    for (const loader of LOADERS) {
      const sets = projects.map(
        (p) => p.loaderMap.get(loader.id) as Set<string>,
      );
      if (sets.some((s) => s.size === 0)) continue; // some project has no builds for this loader
      let intersection = [...(sets[0] as Set<string>)];
      for (const s of sets.slice(1))
        intersection = intersection.filter((gv) => s.has(gv));
      for (const gv of intersection)
        fullPairs.push(this.pairMeta(loader.id, gv));
    }
    fullPairs.sort((a, b) => this.comparePairs(a, b));

    const best: SolveBest | null = fullPairs.length
      ? { ...(fullPairs[0] as PairMeta), coverage: 'all' }
      : null;
    const alternatives = fullPairs.slice(1, 6);

    // Partial fallback: the (loader, MC version) pair supported by the MOST
    // projects, with the same newest-first/loader-preference tiebreaks.
    let partial: SolvePartial | null = null;
    if (!best) {
      let bestPartial: (PairMeta & { covered: SolveProject[] }) | null = null;
      for (const loader of LOADERS) {
        const union = new Set<string>();
        for (const p of projects)
          for (const gv of p.loaderMap.get(loader.id) || []) union.add(gv);
        for (const gv of union) {
          const covered = projects.filter((p) =>
            p.loaderMap.get(loader.id)?.has(gv),
          );
          const cand = { ...this.pairMeta(loader.id, gv), covered };
          if (
            !bestPartial ||
            covered.length > bestPartial.covered.length ||
            (covered.length === bestPartial.covered.length &&
              this.comparePairs(cand, bestPartial) < 0)
          ) {
            bestPartial = cand;
          }
        }
      }
      if (bestPartial) {
        const coveredSet = new Set(bestPartial.covered.map((p) => p.key));
        partial = {
          loader: bestPartial.loader,
          loaderLabel: bestPartial.loaderLabel,
          type: bestPartial.type,
          mcVersion: bestPartial.mcVersion,
          coveredCount: bestPartial.covered.length,
          total: projects.length,
          coveredKeys: [...coveredSet],
          dropped: projects
            .filter((p) => !coveredSet.has(p.key))
            .map((p) => ({
              platform: p.platform,
              ref: p.ref,
              slug: p.slug,
              title: p.title,
              // What this project DOES support on the chosen loader (newest few),
              // so the UI can say "only up to 1.20.1 on Fabric" or "no Fabric builds".
              supportedVersions: [
                ...(p.loaderMap.get((bestPartial as PairMeta).loader) || []),
              ]
                .sort((a, b) => this.compareMcDesc(a, b))
                .slice(0, 8),
            })),
        };
      }
    }

    // Per-project detail for the result card. `supported` is judged against the
    // best pair (or the partial pair when nothing covers everything).
    const judged: PairMeta | null = best || partial;
    const perProject: SolvePerProject[] = projects.map((p) => ({
      platform: p.platform,
      key: p.key,
      ref: p.ref,
      slug: p.slug,
      title: p.title,
      iconUrl: p.iconUrl,
      supported: judged
        ? Boolean(p.loaderMap.get(judged.loader)?.has(judged.mcVersion))
        : false,
      // Newest MC versions this project supports on the judged loader (falls back
      // to its overall best loader when it has none there).
      bestOwnVersions: this.bestOwnVersions(p, judged ? judged.loader : null),
    }));

    return { best, alternatives, perProject, partial };
  }

  private bestOwnVersions(
    project: SolveProject,
    preferredLoader: string | null,
  ): { loader: string | null; versions: string[] } {
    const pick = (loaderId: string) =>
      [...(project.loaderMap.get(loaderId) || [])]
        .sort((a, b) => this.compareMcDesc(a, b))
        .slice(0, 5);
    if (preferredLoader && project.loaderMap.get(preferredLoader)?.size) {
      return { loader: preferredLoader, versions: pick(preferredLoader) };
    }
    for (const loader of LOADERS) {
      if (project.loaderMap.get(loader.id)?.size)
        return { loader: loader.id, versions: pick(loader.id) };
    }
    return { loader: null, versions: [] };
  }
}
