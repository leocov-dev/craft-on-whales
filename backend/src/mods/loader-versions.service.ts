import { Injectable } from '@nestjs/common';
import { ApiCacheService } from './api-cache.service';

// Loader BUILD versions for the "From mods" wizard, so a server can pin a
// specific Fabric/Quilt/NeoForge/Forge loader instead of always tracking latest.
// Each source is a public JSON endpoint; results are cached in api_cache and the
// call is best-effort — on any failure we still return a usable "Latest" option
// so the picker never dead-ends. The chosen build maps to the itzg env var:
//   fabric → FABRIC_LOADER_VERSION   quilt → QUILT_LOADER_VERSION
//   neoforge → NEOFORGE_VERSION      forge → FORGE_VERSION
// An empty version means "don't pin" — let the image resolve the latest itself.

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_BUILDS = 40; // keep the dropdown sane; power users have the advanced env field

/** One selectable build option in the loader-version dropdown. */
export interface LoaderBuild {
  version: string;
  label: string;
}

/** Result of getBuilds(): the full dropdown + which env var a chosen build pins. */
export interface LoaderBuildsResult {
  loader: string;
  envKey: string | null;
  builds: LoaderBuild[];
  default: string;
}

const LATEST: LoaderBuild = { version: '', label: 'Latest (recommended)' };

const ENV_KEY: Record<string, string> = {
  fabric: 'FABRIC_LOADER_VERSION',
  quilt: 'QUILT_LOADER_VERSION',
  neoforge: 'NEOFORGE_VERSION',
  forge: 'FORGE_VERSION',
};

interface FabricLoaderVersion {
  version?: string;
  stable?: boolean;
}

@Injectable()
export class LoaderVersionsService {
  constructor(private readonly cache: ApiCacheService) {}

  /** itzg env var that pins this loader's build (null for loaders without one). */
  envKeyFor(loader: string): string | null {
    return ENV_KEY[String(loader).toLowerCase()] || null;
  }

  private async cachedJson(cacheKey: string, url: string): Promise<unknown> {
    const cached = await this.cache.get(cacheKey);
    if (cached && cached.ageMs < TTL_MS) return cached.value;
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: unknown = await res.json();
      this.cache.set(cacheKey, data);
      return data;
    } catch (err) {
      if (cached) return cached.value; // stale beats nothing
      throw err;
    }
  }

  // Fabric & Quilt loader versions are independent of the Minecraft version.
  private async fabricBuilds(): Promise<LoaderBuild[]> {
    const list = (await this.cachedJson(
      'loader:fabric',
      'https://meta.fabricmc.net/v2/versions/loader',
    )) as FabricLoaderVersion[] | null | undefined;
    return (list || [])
      .filter(
        (
          v,
        ): v is Required<Pick<FabricLoaderVersion, 'version'>> &
          FabricLoaderVersion => Boolean(v && v.version),
      )
      .slice(0, MAX_BUILDS)
      .map((v) => ({
        version: v.version,
        label: v.stable ? `${v.version} (stable)` : v.version,
      }));
  }

  private async quiltBuilds(): Promise<LoaderBuild[]> {
    const list = (await this.cachedJson(
      'loader:quilt',
      'https://meta.quiltmc.org/v3/versions/loader',
    )) as FabricLoaderVersion[] | null | undefined;
    return (list || [])
      .filter(
        (
          v,
        ): v is Required<Pick<FabricLoaderVersion, 'version'>> &
          FabricLoaderVersion => Boolean(v && v.version),
      )
      .slice(0, MAX_BUILDS)
      .map((v) => ({ version: v.version, label: v.version }));
  }

  /** NeoForge encodes the MC version in its build: 1.21.1 → "21.1.x", 1.21 → "21.0.x". */
  private neoforgePrefix(mc: string | null | undefined): string | null {
    const m = /^1\.(\d+)(?:\.(\d+))?$/.exec(String(mc || ''));
    return m ? `${m[1]}.${m[2] || '0'}.` : null;
  }

  private async neoforgeBuilds(
    mc: string | null | undefined,
  ): Promise<LoaderBuild[]> {
    const data = (await this.cachedJson(
      'loader:neoforge',
      'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge',
    )) as { versions?: string[] };
    const all = (data.versions || []).slice().reverse(); // maven returns ascending; newest first
    const prefix = this.neoforgePrefix(mc);
    const matched = prefix ? all.filter((v) => v.startsWith(prefix)) : all;
    return matched.slice(0, MAX_BUILDS).map((v) => ({
      version: v,
      label: /-beta$/i.test(v) ? `${v} (beta)` : v,
    }));
  }

  // Forge's promotions feed only surfaces the recommended + latest build per MC —
  // that covers what almost everyone pins; the advanced FORGE_VERSION field remains
  // for arbitrary builds.
  private async forgeBuilds(
    mc: string | null | undefined,
  ): Promise<LoaderBuild[]> {
    const data = (await this.cachedJson(
      'loader:forge',
      'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
    )) as { promos?: Record<string, string> };
    const promos = data.promos || {};
    const recommended = promos[`${mc}-recommended`];
    const latest = promos[`${mc}-latest`];
    const builds: LoaderBuild[] = [];
    if (recommended)
      builds.push({
        version: recommended,
        label: `${recommended} (recommended)`,
      });
    if (latest && latest !== recommended)
      builds.push({ version: latest, label: `${latest} (latest)` });
    return builds;
  }

  /**
   * Build list for a loader (+ MC where the loader is MC-specific). Always starts
   * with the "Latest" no-pin option, then specific builds newest-first when the
   * registry is reachable. Never throws — a failed fetch yields the Latest option.
   */
  async getBuilds(
    loader: string,
    mc: string | null | undefined,
  ): Promise<LoaderBuildsResult> {
    const key = String(loader).toLowerCase();
    let builds: LoaderBuild[] = [];
    try {
      if (key === 'fabric') builds = await this.fabricBuilds();
      else if (key === 'quilt') builds = await this.quiltBuilds();
      else if (key === 'neoforge') builds = await this.neoforgeBuilds(mc);
      else if (key === 'forge') builds = await this.forgeBuilds(mc);
    } catch {
      builds = []; // best-effort — fall through to Latest-only
    }
    return {
      loader: key,
      envKey: this.envKeyFor(key),
      builds: [LATEST, ...builds],
      default: '',
    };
  }
}
