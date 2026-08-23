import { Injectable } from '@nestjs/common';
import { ModrinthApiService } from './modrinth-api.service';
import { CurseforgeApiService } from './curseforge-api.service';
import type { ModPlatform, ModrinthVersion, CurseforgeFile } from './mods.types';

// Backend for the "From mods" wizard browser. Three concerns, both platforms:
//   search()   — find mods for a loader + MC version (Modrinth or CurseForge)
//   versions() — a mod's builds filtered to that loader + MC, newest first
//   resolveDependencies() — the required-dependency closure of a selection,
//                           so the wizard can show "added as dependency" rows
// A dependency stays on the same platform as its parent (Modrinth project ids
// and CurseForge mod ids never cross), so no cross-platform mapping is needed.

const MAX_DEPS = 50; // safety cap on the resolved-dependency closure
const MAX_ITER = 300; // recursion guard

function normMc(mc: string | null | undefined): string | undefined {
  const v = String(mc || '').trim();
  return v && v !== 'LATEST' && v !== 'SNAPSHOT' ? v : undefined;
}

/** A single unified search result row, same shape for either platform. */
export interface ModSearchHit {
  platform: ModPlatform;
  ref: string;
  projectId: string;
  name: string;
  description: string;
  iconUrl: string | null;
  downloads: number;
}

export interface ModBrowserSearchParams {
  query: string | null | undefined;
  platform?: ModPlatform;
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

/** A mod build/version, normalized to a shared shape across both platforms. */
export interface ModVersion {
  versionId: string;
  name: string;
  versionNumber: string;
  datePublished: string | null;
  versionType: string;
  gameVersions: string[];
  requiredDeps: string[];
  /** CurseForge only — authors can forbid API download. */
  downloadable?: boolean;
}

export interface ModBrowserVersionsParams {
  platform: ModPlatform;
  ref: string;
  loader?: string;
  mc?: string;
  limit?: number;
}

/** One selection entry the wizard passes in to resolveDependencies(). */
export interface DepSelectionEntry {
  platform: ModPlatform;
  ref: string;
  versionId?: string | null;
}

/** One resolved dependency, editable in the wizard before install. */
export interface ResolvedDep {
  platform: ModPlatform;
  ref: string;
  projectId: string;
  name: string;
  iconUrl: string | null;
  versions: ModVersion[];
  versionId: string;
}

interface QueueNode {
  platform: ModPlatform;
  projectId: string;
}

@Injectable()
export class ModBrowserService {
  constructor(
    private readonly modrinth: ModrinthApiService,
    private readonly curseforge: CurseforgeApiService
  ) {}

  /** Unified mod search. Returns [{platform, ref, projectId, name, description, iconUrl, downloads}]. */
  async search({ query, platform, loader, mc, limit = 20 }: ModBrowserSearchParams): Promise<ModSearchHit[]> {
    const q = String(query || '').trim();
    if (!q) return [];
    const mcVersion = normMc(mc);
    if (platform === 'curseforge') {
      const hits = await this.curseforge.search({ query: q, kind: 'mod', loader, mcVersion, limit });
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
    const hits = await this.modrinth.search({ query: q, kind: 'mod', loader, mcVersion, limit });
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

  /** {ref, projectId, name, iconUrl} for a mod given a slug or platform id. */
  async metaFor(platform: ModPlatform, refOrId: string): Promise<ModMeta> {
    if (platform === 'curseforge') {
      const mod = /^\d+$/.test(String(refOrId)) ? await this.curseforge.getMod(Number(refOrId)) : await this.curseforge.resolveUrl(String(refOrId));
      return { ref: mod.slug, projectId: String(mod.modId), name: mod.name, iconUrl: mod.iconUrl || null };
    }
    const p = await this.modrinth.getProject(refOrId);
    return { ref: p.slug, projectId: p.id, name: p.title, iconUrl: p.icon_url || null };
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
      requiredDeps: (v.dependencies || []).filter((d) => d.dependency_type === 'required' && d.project_id).map((d) => String(d.project_id)),
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
      requiredDeps: (f.dependencies || []).filter((d) => d.relation === 3).map((d) => String(d.modId)),
      downloadable: Boolean(f.downloadUrl), // CF authors can forbid API download
    };
  }

  /** A mod's builds for a loader + MC version, newest first. */
  async versions({ platform, ref, loader, mc, limit = 30 }: ModBrowserVersionsParams): Promise<ModVersion[]> {
    const mcVersion = normMc(mc);
    if (platform === 'curseforge') {
      const meta = await this.metaFor('curseforge', ref);
      const files = await this.curseforge.getFiles(Number(meta.projectId), { mcVersion, loader });
      return files.slice(0, limit).map((f) => this.normCurseforgeFile(f));
    }
    const list = await this.modrinth.getVersions(ref, { loader, mcVersion });
    return list.slice(0, limit).map((v) => this.normModrinthVersion(v));
  }

  private depKey(platform: ModPlatform, projectId: string): string {
    return `${platform}:${projectId}`;
  }

  /** Required-dependency project ids of ONE build (same platform as its parent). */
  private async requiredDepsOfVersion(platform: ModPlatform, projectId: string, versionId: string): Promise<string[]> {
    try {
      if (platform === 'curseforge') {
        const file = await this.curseforge.getFile(Number(projectId), Number(versionId));
        return this.normCurseforgeFile(file).requiredDeps;
      }
      const v = await this.modrinth.getVersion(versionId);
      return this.normModrinthVersion(v).requiredDeps;
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
      const reqs = item.versionId ? await this.requiredDepsOfVersion(item.platform, meta.projectId, item.versionId) : [];
      for (const pid of reqs) queue.push({ platform: item.platform, projectId: pid });
    }

    let iter = 0;
    while (queue.length && iter < MAX_ITER && deps.length < MAX_DEPS) {
      iter += 1;
      const node = queue.shift()!;
      const k = this.depKey(node.platform, node.projectId);
      if (have.has(k)) continue;
      have.add(k);

      let meta: ModMeta;
      try {
        meta = await this.metaFor(node.platform, node.projectId);
      } catch {
        continue; // unresolvable id — skip quietly
      }
      let vers: ModVersion[] = [];
      try {
        vers = await this.versions({ platform: node.platform, ref: meta.ref, loader, mc });
      } catch {
        vers = [];
      }
      if (!vers.length) {
        warnings.push(`${meta.name} has no ${loader}${mc ? ` ${mc}` : ''} build — skipped`);
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
      for (const pid of chosen.requiredDeps) queue.push({ platform: node.platform, projectId: pid });
    }

    return { deps, warnings };
  }
}
