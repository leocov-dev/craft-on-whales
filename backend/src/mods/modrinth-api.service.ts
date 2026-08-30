import {
  Injectable,
  NotFoundException,
  HttpException,
  BadGatewayException,
} from '@nestjs/common';
import type { ZodType } from 'zod';
import { ApiCacheService } from './api-cache.service';
import type {
  ModrinthSearchHit,
  ModrinthResolved,
  ModrinthProject,
  ModrinthVersion,
  ModrinthFile,
} from './mods.types';
import {
  searchResponseSchema,
  projectSchema,
  versionSchema,
  versionListSchema,
} from './modrinth-api.schemas';

const BASE = 'https://api.modrinth.com/v2';
const UA = 'MinecraftServerManager/0.1 (self-hosted panel; contact via repo)';

interface MrFetchOptions {
  ttlMs?: number;
  search?: Record<string, string>;
}

export interface ModrinthSearchParams {
  query?: string;
  kind?: 'mod' | 'plugin' | 'datapack' | 'resourcepack' | 'modpack';
  loader?: string;
  mcVersion?: string;
  limit?: number;
  offset?: number;
}

/** Modrinth public API client (no key required). Cached + rate-limit friendly. Docs: https://docs.modrinth.com/api */
@Injectable()
export class ModrinthApiService {
  constructor(private readonly cache: ApiCacheService) {}

  private async mrFetch<T>(
    pathname: string,
    schema: ZodType<T>,
    { ttlMs = 10 * 60 * 1000, search }: MrFetchOptions = {},
  ): Promise<T> {
    const url = new URL(BASE + pathname);
    if (search)
      for (const [k, v] of Object.entries(search)) url.searchParams.set(k, v);
    const cacheKey = `modrinth:${url.pathname}${url.search}`;
    const cached = await this.cache.get(cacheKey);
    if (cached && cached.ageMs < ttlMs) return schema.parse(cached.value);
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429) {
      if (cached) return schema.parse(cached.value);
      throw new HttpException(
        'Modrinth rate limit hit — try again in a minute',
        429,
      );
    }
    if (res.status === 404)
      throw new NotFoundException('Not found on Modrinth');
    if (!res.ok)
      throw new BadGatewayException(`Modrinth answered HTTP ${res.status}`);
    const json: unknown = await res.json();
    let data: T;
    try {
      data = schema.parse(json);
    } catch {
      throw new BadGatewayException(
        `Modrinth returned an unexpected response shape for ${pathname}`,
      );
    }
    void this.cache.set(cacheKey, json).catch(() => undefined);
    return data;
  }

  async search({
    query = '',
    kind = 'mod',
    loader,
    mcVersion,
    limit = 20,
    offset = 0,
  }: ModrinthSearchParams): Promise<ModrinthSearchHit[]> {
    const facets: string[][] = [];
    if (kind === 'plugin')
      facets.push([
        'categories:paper',
        'categories:spigot',
        'categories:bukkit',
        'categories:purpur',
      ]);
    else if (kind) facets.push([`project_type:${kind}`]);
    if (loader && kind !== 'plugin')
      facets.push([`categories:${loader.toLowerCase()}`]);
    if (mcVersion) facets.push([`versions:${mcVersion}`]);
    const data = await this.mrFetch('/search', searchResponseSchema, {
      search: {
        query,
        limit: String(limit),
        offset: String(offset),
        index: 'relevance',
        facets: JSON.stringify(facets),
      },
      ttlMs: 5 * 60 * 1000,
    });
    return data.hits.map((h) => ({
      projectId: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      iconUrl: h.icon_url || null,
      downloads: h.downloads,
      categories: h.categories,
      latestVersion: h.latest_version,
    }));
  }

  getProject(idOrSlug: string): Promise<ModrinthProject> {
    return this.mrFetch(
      `/project/${encodeURIComponent(idOrSlug)}`,
      projectSchema,
      { ttlMs: 30 * 60 * 1000 },
    );
  }

  /** Version list filtered to the server's loader + MC version. */
  async getVersions(
    idOrSlug: string,
    { loader, mcVersion }: { loader?: string; mcVersion?: string } = {},
  ): Promise<ModrinthVersion[]> {
    const search: Record<string, string> = {};
    if (loader) search.loaders = JSON.stringify([loader.toLowerCase()]);
    if (mcVersion) search.game_versions = JSON.stringify([mcVersion]);
    return this.mrFetch(
      `/project/${encodeURIComponent(idOrSlug)}/version`,
      versionListSchema,
      { search, ttlMs: 10 * 60 * 1000 },
    );
  }

  getVersion(versionId: string): Promise<ModrinthVersion> {
    return this.mrFetch(
      `/version/${encodeURIComponent(versionId)}`,
      versionSchema,
      { ttlMs: 60 * 60 * 1000 },
    );
  }

  /**
   * Resolve any Modrinth URL (or slug) to {projectId, slug, versionId?}.
   * Handles /mod|plugin|datapack|resourcepack|modpack/<slug>[/version/<ver>].
   */
  async resolveUrl(input: string): Promise<ModrinthResolved> {
    let slug = input.trim();
    let versionRef: string | null = null;
    const m =
      /modrinth\.com\/(?:mod|plugin|datapack|resourcepack|modpack)\/([^/]+)(?:\/version\/([^/?#]+))?/.exec(
        input,
      );
    if (m) {
      slug = m[1]!;
      versionRef = m[2] || null;
    }
    const project = await this.getProject(slug);
    let versionId: string | null = null;
    if (versionRef) {
      const versions = await this.mrFetch(
        `/project/${project.id}/version`,
        versionListSchema,
        { ttlMs: 10 * 60 * 1000 },
      );
      const v = versions.find(
        (x) =>
          x.id === versionRef ||
          x.version_number === decodeURIComponent(versionRef),
      );
      versionId = v ? v.id : null;
    }
    return {
      projectId: project.id,
      slug: project.slug,
      title: project.title,
      iconUrl: project.icon_url || null,
      projectType: project.project_type,
      versionId,
    };
  }

  /** Pick the file to download from a version object (primary first). */
  primaryFile(version: ModrinthVersion): ModrinthFile {
    return version.files.find((f) => f.primary) || version.files[0]!;
  }
}
