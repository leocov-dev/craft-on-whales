import {
  Injectable,
  NotFoundException,
  HttpException,
  BadGatewayException,
  BadRequestException,
} from '@nestjs/common';
import type { ZodType } from 'zod';
import { ApiCacheService } from './api-cache.service';
import { parseSourceUrl } from './source-url.util';
import type {
  SpigetResource,
  SpigetResourceRef,
  SpigetResolved,
  SpigetVersion,
} from './mods.types';
import {
  spigetResourceSchema,
  spigetResourceListSchema,
  spigetVersionSchema,
  spigetVersionListSchema,
  type RawSpigetResource,
  type RawSpigetVersion,
} from './spiget-api.schemas';

const BASE = 'https://api.spiget.org/v2';
const UA = 'MinecraftServerManager/0.1 (self-hosted panel; contact via repo)';

interface SpigetFetchOptions {
  ttlMs?: number;
  search?: Record<string, string | number>;
}

/**
 * Parse the forms people paste for a SpigotMC resource: a bare numeric id,
 * SpigotMC's own `name.12345` URL tail, or a full
 * `spigotmc.org/resources/<name.>12345/...` URL. A `?version=<id>` query pins
 * a specific build. Returns null for anything else.
 */
export function parseSpigetRef(input: string): SpigetResourceRef | null {
  const s = input.trim();
  const page = parseSourceUrl(s, 'spigotmc.org');
  if (page) {
    const [section, tail] = page.segments;
    const id =
      section === 'resources' && tail ? /(?:^|\.)(\d+)$/.exec(tail) : null;
    if (!id) return null;
    const pinned = page.searchParams.get('version');
    return {
      resourceId: Number(id[1]),
      versionId: pinned && /^\d+$/.test(pinned) ? pinned : null,
    };
  }
  // The name prefix must contain a non-digit so a version-like "1.21" isn't
  // mistaken for resource 21.
  const bare = /^(?:[\w-]*[A-Za-z_-][\w-]*\.)?(\d+)$/.exec(s);
  return bare ? { resourceId: Number(bare[1]), versionId: null } : null;
}

/**
 * Spiget API client — the SpigotMC resource catalog, no key required.
 * Docs: https://spiget.org/documentation. Downloads go through Spiget's
 * `/download/proxy` CDN endpoint rather than spigotmc.org itself, whose
 * Cloudflare challenge blocks non-browser clients. Resources hosted off-site
 * ("external") or sold ("premium") can't be proxied — callers must surface
 * those as manual downloads. Spiget publishes no file hashes.
 */
@Injectable()
export class SpigetApiService {
  constructor(private readonly cache: ApiCacheService) {}

  private async spigetFetch<T>(
    pathname: string,
    schema: ZodType<T>,
    { ttlMs = 10 * 60 * 1000, search }: SpigetFetchOptions = {},
  ): Promise<T> {
    const url = new URL(BASE + pathname);
    if (search)
      for (const [k, v] of Object.entries(search))
        url.searchParams.set(k, String(v));
    const cacheKey = `spiget:${url.pathname}${url.search}`;
    const cached = await this.cache.get(cacheKey);
    if (cached && cached.ageMs < ttlMs) return schema.parse(cached.value);
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429) {
      if (cached) return schema.parse(cached.value); // stale beats a hard failure
      throw new HttpException(
        'Spiget rate limit hit — try again in a minute',
        429,
      );
    }
    if (res.status === 404)
      throw new NotFoundException('Not found on SpigotMC');
    if (!res.ok)
      throw new BadGatewayException(`Spiget answered HTTP ${res.status}`);
    const json: unknown = await res.json();
    let data: T;
    try {
      data = schema.parse(json);
    } catch {
      throw new BadGatewayException(
        `Spiget returned an unexpected response shape for ${pathname}`,
      );
    }
    void this.cache.set(cacheKey, json).catch(() => undefined);
    return data;
  }

  /** Search resources by name, most-downloaded first. */
  async search({
    query = '',
    limit = 20,
  }: {
    query?: string;
    limit?: number;
  }): Promise<SpigetResource[]> {
    const q = query.trim();
    if (!q) return [];
    try {
      const data = await this.spigetFetch(
        `/search/resources/${encodeURIComponent(q)}`,
        spigetResourceListSchema,
        {
          search: {
            field: 'name',
            size: Math.min(limit, 50),
            sort: '-downloads',
          },
          ttlMs: 5 * 60 * 1000,
        },
      );
      return data.map((r) => this.normalizeResource(r));
    } catch (err) {
      // Spiget answers an empty search result with a 404.
      if (err instanceof NotFoundException) return [];
      throw err;
    }
  }

  async getResource(resourceId: number): Promise<SpigetResource> {
    const data = await this.spigetFetch(
      `/resources/${this.assertId(resourceId)}`,
      spigetResourceSchema,
      { ttlMs: 30 * 60 * 1000 },
    );
    return this.normalizeResource(data);
  }

  /**
   * A resource's versions, newest first. Sorted by id rather than
   * `releaseDate`: Spiget's `-releaseDate` sort was observed returning an
   * older build ahead of the current one, while ids are strictly increasing.
   */
  async getVersions(
    resourceId: number,
    { limit = 30 }: { limit?: number } = {},
  ): Promise<SpigetVersion[]> {
    const data = await this.spigetFetch(
      `/resources/${this.assertId(resourceId)}/versions`,
      spigetVersionListSchema,
      {
        search: { size: Math.min(limit, 50), sort: '-id' },
        ttlMs: 10 * 60 * 1000,
      },
    );
    return data.map((v) => this.normalizeVersion(v));
  }

  /** One version by id — for a pinned `?version=` that may be older than getVersions' window. */
  async getVersion(
    resourceId: number,
    versionId: string,
  ): Promise<SpigetVersion> {
    const v = await this.spigetFetch(
      `/resources/${this.assertId(resourceId)}/versions/${this.assertId(Number(versionId))}`,
      spigetVersionSchema,
      { ttlMs: 60 * 60 * 1000 },
    );
    return this.normalizeVersion(v);
  }

  /** The Cloudflare-dodging CDN download URL for one version (omit `versionId` for the latest). */
  downloadUrl(resourceId: number, versionId?: string): string {
    const version =
      versionId === undefined ? 'latest' : this.assertId(Number(versionId));
    return `${BASE}/resources/${this.assertId(resourceId)}/versions/${version}/download/proxy`;
  }

  /** Resolve a pasted SpigotMC URL / `name.id` / id to the resource plus any pinned version. */
  async resolveUrl(input: string): Promise<SpigetResolved> {
    const ref = parseSpigetRef(input);
    if (!ref)
      throw new BadRequestException(
        'Could not read a SpigotMC resource id from that input',
      );
    const resource = await this.getResource(ref.resourceId);
    return { ...resource, versionId: ref.versionId };
  }

  private assertId(id: number): number {
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new BadRequestException('Invalid SpigotMC resource id');
    return id;
  }

  private normalizeVersion(v: RawSpigetVersion): SpigetVersion {
    return {
      versionId: String(v.id),
      name: v.name || String(v.id),
      datePublished: v.releaseDate
        ? new Date(v.releaseDate * 1000).toISOString()
        : null,
    };
  }

  private normalizeResource(r: RawSpigetResource): SpigetResource {
    return {
      resourceId: r.id,
      name: r.name,
      tag: r.tag || '',
      downloads: r.downloads ?? 0,
      // Spiget serves icon paths relative to spigotmc.org.
      iconUrl: r.icon?.url ? `https://www.spigotmc.org/${r.icon.url}` : null,
      testedVersions: r.testedVersions ?? [],
      external: Boolean(r.external || r.file?.type === 'external'),
      premium: Boolean(r.premium),
      externalUrl: r.file?.externalUrl || null,
      pageUrl: `https://www.spigotmc.org/resources/${r.id}/`,
    };
  }
}
