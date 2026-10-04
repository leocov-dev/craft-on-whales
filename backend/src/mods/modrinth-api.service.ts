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
  ModrinthVersionWithProject,
} from './mods.types';
import {
  searchResponseSchema,
  projectSchema,
  versionSchema,
  versionListSchema,
  versionFilesResponseSchema,
  projectListSchema,
} from './modrinth-api.schemas';
import { acceptedLoaders, preferOwnLoader } from './loader-compat';

const BASE = 'https://api.modrinth.com/v2';
const UA = 'MinecraftServerManager/0.1 (self-hosted panel; contact via repo)';
// Hashes / ids per bulk request. Modrinth documents no hard cap; this keeps a
// big pack's request bodies and query strings a sane size.
const BULK_CHUNK = 200;

interface MrFetchOptions {
  ttlMs?: number;
  search?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: unknown;
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
    {
      ttlMs = 10 * 60 * 1000,
      search,
      method = 'GET',
      body,
    }: MrFetchOptions = {},
  ): Promise<T> {
    const url = new URL(BASE + pathname);
    if (search)
      for (const [k, v] of Object.entries(search)) url.searchParams.set(k, v);
    // Only GETs are cached, as in cfFetch: the cache key has no body in it.
    const cacheKey = `modrinth:${url.pathname}${url.search}`;
    const cached = method === 'GET' ? await this.cache.get(cacheKey) : null;
    if (cached && cached.ageMs < ttlMs) return schema.parse(cached.value);
    const res = await fetch(url, {
      method,
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
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
    if (method === 'GET')
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
    // One OR-group: a Quilt server also matches fabric-tagged projects.
    if (loader && kind !== 'plugin')
      facets.push(acceptedLoaders(loader).map((l) => `categories:${l}`));
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
      gameVersions: h.versions ?? [],
    }));
  }

  getProject(idOrSlug: string): Promise<ModrinthProject> {
    return this.mrFetch(
      `/project/${encodeURIComponent(idOrSlug)}`,
      projectSchema,
      { ttlMs: 30 * 60 * 1000 },
    );
  }

  /**
   * Version list filtered to the server's loader + MC version. A loader with
   * fallbacks (Quilt, which also runs Fabric builds) lists those too, but
   * builds tagged with the server's own loader come first.
   */
  async getVersions(
    idOrSlug: string,
    { loader, mcVersion }: { loader?: string; mcVersion?: string } = {},
  ): Promise<ModrinthVersion[]> {
    const search: Record<string, string> = {};
    if (loader) search.loaders = JSON.stringify(acceptedLoaders(loader));
    if (mcVersion) search.game_versions = JSON.stringify([mcVersion]);
    const versions = await this.mrFetch(
      `/project/${encodeURIComponent(idOrSlug)}/version`,
      versionListSchema,
      { search, ttlMs: 10 * 60 * 1000 },
    );
    return preferOwnLoader(versions, loader, (v) => v.loaders);
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

  /**
   * Reverse lookup by file hash (POST /version_files), batched. Maps each
   * hash Modrinth knows (lowercased) to the version that file belongs to.
   * Unknown hashes are absent, not an error.
   */
  async getVersionsByHashes(
    hashes: string[],
    algorithm: 'sha1' | 'sha512' = 'sha1',
  ): Promise<Map<string, ModrinthVersionWithProject>> {
    const unique = [...new Set(hashes.map((h) => h.toLowerCase()))];
    const out = new Map<string, ModrinthVersionWithProject>();
    for (let i = 0; i < unique.length; i += BULK_CHUNK) {
      const data = await this.mrFetch(
        '/version_files',
        versionFilesResponseSchema,
        {
          method: 'POST',
          body: { hashes: unique.slice(i, i + BULK_CHUNK), algorithm },
        },
      );
      for (const [hash, version] of Object.entries(data))
        out.set(hash.toLowerCase(), version);
    }
    return out;
  }

  /** Several projects at once (GET /projects?ids=[...]), keyed by project id. */
  async getProjects(ids: string[]): Promise<Map<string, ModrinthProject>> {
    const unique = [...new Set(ids)];
    const out = new Map<string, ModrinthProject>();
    for (let i = 0; i < unique.length; i += BULK_CHUNK) {
      const data = await this.mrFetch('/projects', projectListSchema, {
        search: { ids: JSON.stringify(unique.slice(i, i + BULK_CHUNK)) },
        ttlMs: 30 * 60 * 1000,
      });
      for (const p of data) out.set(p.id, p);
    }
    return out;
  }

  /** Pick the file to download from a version object (primary first). */
  primaryFile(version: ModrinthVersion): ModrinthFile {
    return version.files.find((f) => f.primary) || version.files[0]!;
  }
}
