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
  ExpectedHash,
  HangarProject,
  HangarResolved,
  HangarVersion,
} from './mods.types';
import {
  hangarProjectSchema,
  hangarProjectListSchema,
  hangarVersionSchema,
  hangarVersionListSchema,
  type RawHangarProject,
  type RawHangarVersion,
} from './hangar-api.schemas';

const BASE = 'https://hangar.papermc.io/api/v1';
const UA = 'MinecraftServerManager/0.1 (self-hosted panel; contact via repo)';

/**
 * The panel manages Paper-family game servers; Hangar also hosts proxy
 * (VELOCITY/WATERFALL) builds, but nothing here targets proxies.
 */
export const HANGAR_PLATFORM = 'PAPER';

const SLUG_RE = /^[\w.-]+$/;

interface HangarFetchOptions {
  ttlMs?: number;
  search?: Record<string, string | number | undefined>;
}

export interface HangarSearchParams {
  query?: string;
  mcVersion?: string;
  limit?: number;
  offset?: number;
}

/**
 * Hangar tags compatibility as a list that can mix bare minors ("1.21") and
 * patches ("1.21.4") — accept an exact match, or a bare-minor tag that
 * prefixes the server's version (a server on 1.21.1 fits a "1.21" tag, but
 * "1.2" must never prefix-match "1.21").
 */
export function hangarCompatibleWith(
  gameVersions: string[],
  mcVersion: string,
): boolean {
  return gameVersions.some(
    (g) =>
      g === mcVersion ||
      (!/^\d+\.\d+\.\d+/.test(g) && mcVersion.startsWith(`${g}.`)),
  );
}

/**
 * Hangar-hosted files always carry a sha256; externally-linked versions
 * carry none. Returns null in that case — LibraryService logs-and-skips.
 */
export function hangarExpectedHash(
  version: HangarVersion,
): ExpectedHash | null {
  return version.sha256 ? { algorithm: 'sha256', hex: version.sha256 } : null;
}

/**
 * The build an installed Hangar version should update to, or null when
 * there's nothing newer. `versions` is newest first (getVersions order,
 * already MC-filtered); `installed` is the installed build's own record when
 * it could be looked up.
 *
 * Channel-following: a build on the Release channel only updates to a newer
 * release, the same preference add-by-link has (ViaVersion-style projects
 * publish many more snapshots than releases). A build on a Snapshot/Beta
 * channel was a deliberate opt-in (a pinned link, or a project with no
 * release at all), so it updates to the newest build of any channel. An
 * installed build that can't be looked up counts as release.
 *
 * Never offers a downgrade: when the installed build is in the list, only
 * builds ahead of it count; when it isn't (older than the window, or not
 * tagged for this MC version), the candidate must be published after it.
 */
export function pickHangarUpdate(
  versions: HangarVersion[],
  installedName: string | null,
  installed: HangarVersion | null,
): HangarVersion | null {
  const followsRelease = !installed || installed.versionType === 'release';
  const candidate = followsRelease
    ? versions.find((v) => v.versionType === 'release')
    : versions[0];
  if (!candidate || candidate.name === installedName) return null;
  const installedIdx = versions.findIndex((v) => v.name === installedName);
  if (installedIdx >= 0) {
    return versions.indexOf(candidate) < installedIdx ? candidate : null;
  }
  const after = Date.parse(candidate.datePublished ?? '');
  const before = Date.parse(installed?.datePublished ?? '');
  if (Number.isFinite(after) && Number.isFinite(before) && after <= before)
    return null;
  return candidate;
}

/**
 * Parse the forms people paste for a Hangar project: a page URL
 * (`hangar.papermc.io/<owner>/<slug>[/versions/<version>]`), `owner/slug`,
 * or a bare slug. Hangar's API addresses projects by slug alone, so the
 * owner is dropped. Returns null for anything else.
 */
export function parseHangarRef(
  input: string,
): { slug: string; versionName: string | null } | null {
  const page = parseSourceUrl(input, 'hangar.papermc.io');
  if (page) {
    const [owner, slug, sub, version] = page.segments;
    if (!owner || !slug || !isSlug(owner) || !isSlug(slug)) return null;
    return {
      slug,
      versionName: sub === 'versions' && version ? version : null,
    };
  }
  const parts = input.trim().split('/');
  if (parts.length > 2 || !parts.every(isSlug)) return null;
  return { slug: parts[parts.length - 1]!, versionName: null };
}

function isSlug(s: string): boolean {
  return SLUG_RE.test(s) && s !== '.' && s !== '..';
}

/**
 * Hangar public API client — PaperMC's own plugin registry, no key required.
 * Docs: https://hangar.papermc.io/api-docs. Versions are platform-tagged and
 * carry per-platform compatible MC versions; Hangar-hosted files publish a
 * sha256.
 */
@Injectable()
export class HangarApiService {
  constructor(private readonly cache: ApiCacheService) {}

  private async hangarFetch<T>(
    pathname: string,
    schema: ZodType<T>,
    { ttlMs = 10 * 60 * 1000, search }: HangarFetchOptions = {},
  ): Promise<T> {
    const url = new URL(BASE + pathname);
    if (search)
      for (const [k, v] of Object.entries(search))
        if (v !== undefined) url.searchParams.set(k, String(v));
    const cacheKey = `hangar:${url.pathname}${url.search}`;
    const cached = await this.cache.get(cacheKey);
    if (cached && cached.ageMs < ttlMs) return schema.parse(cached.value);
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429) {
      if (cached) return schema.parse(cached.value); // stale beats a hard failure
      throw new HttpException(
        'Hangar rate limit hit — try again in a minute',
        429,
      );
    }
    if (res.status === 404) throw new NotFoundException('Not found on Hangar');
    if (!res.ok)
      throw new BadGatewayException(`Hangar answered HTTP ${res.status}`);
    const json: unknown = await res.json();
    let data: T;
    try {
      data = schema.parse(json);
    } catch {
      throw new BadGatewayException(
        `Hangar returned an unexpected response shape for ${pathname}`,
      );
    }
    void this.cache.set(cacheKey, json).catch(() => undefined);
    return data;
  }

  /** Search plugins; `mcVersion` narrows to projects with a compatible PAPER build. */
  async search({
    query = '',
    mcVersion,
    limit = 20,
    offset = 0,
  }: HangarSearchParams): Promise<HangarProject[]> {
    const data = await this.hangarFetch('/projects', hangarProjectListSchema, {
      search: {
        q: query,
        limit: Math.min(limit, 50),
        offset,
        platform: HANGAR_PLATFORM,
        version: mcVersion || undefined,
      },
      ttlMs: 5 * 60 * 1000,
    });
    return data.result.map((p) => this.normalizeProject(p));
  }

  async getProject(slug: string): Promise<HangarProject> {
    const p = await this.hangarFetch(
      `/projects/${encodeURIComponent(this.assertSlug(slug))}`,
      hangarProjectSchema,
      { ttlMs: 30 * 60 * 1000 },
    );
    return this.normalizeProject(p);
  }

  /**
   * A project's PAPER versions, newest first. With `mcVersion`, versions that
   * declare MC compatibility but not for that version are dropped (versions
   * declaring none are kept — no data isn't a mismatch).
   */
  async getVersions(
    slug: string,
    { mcVersion, limit = 30 }: { mcVersion?: string; limit?: number } = {},
  ): Promise<HangarVersion[]> {
    const data = await this.hangarFetch(
      `/projects/${encodeURIComponent(this.assertSlug(slug))}/versions`,
      hangarVersionListSchema,
      {
        search: {
          limit: Math.min(limit, 50),
          offset: 0,
          platform: HANGAR_PLATFORM,
        },
        ttlMs: 10 * 60 * 1000,
      },
    );
    let versions = data.result
      .map((v) => this.normalizeVersion(v))
      // Keep externally-hosted builds: callers surface them as manual downloads.
      .filter(
        (v) =>
          v.gameVersions.length > 0 ||
          v.downloadUrl !== null ||
          v.externalUrl !== null,
      );
    if (mcVersion)
      versions = versions.filter(
        (v) =>
          !v.gameVersions.length ||
          hangarCompatibleWith(v.gameVersions, mcVersion),
      );
    return versions;
  }

  /** One version by its (per-project unique) name. */
  async getVersion(slug: string, versionName: string): Promise<HangarVersion> {
    const v = await this.hangarFetch(
      `/projects/${encodeURIComponent(this.assertSlug(slug))}/versions/${encodeURIComponent(versionName)}`,
      hangarVersionSchema,
      { ttlMs: 60 * 60 * 1000 },
    );
    return this.normalizeVersion(v);
  }

  /**
   * Resolve a Hangar page URL, `owner/slug`, or bare slug to the project plus
   * the version name the URL pinned (if any).
   */
  async resolveUrl(input: string): Promise<HangarResolved> {
    const ref = parseHangarRef(input);
    if (!ref)
      throw new BadRequestException(
        'Could not read a Hangar project from that input',
      );
    const project = await this.getProject(ref.slug);
    return { ...project, versionName: ref.versionName };
  }

  private assertSlug(slug: string): string {
    const s = slug.trim();
    if (!isSlug(s)) throw new BadRequestException('Invalid Hangar project');
    return s;
  }

  private normalizeProject(p: RawHangarProject): HangarProject {
    return {
      slug: p.namespace.slug,
      owner: p.namespace.owner,
      name: p.name,
      description: p.description || '',
      iconUrl: p.avatarUrl || null,
      downloads: p.stats?.downloads ?? 0,
    };
  }

  private normalizeVersion(v: RawHangarVersion): HangarVersion {
    const dl = v.downloads?.[HANGAR_PLATFORM];
    const channel = v.channel?.name ?? null;
    const downloadUrl = dl?.downloadUrl || null;
    const externalUrl = dl?.externalUrl || null;
    return {
      name: v.name,
      datePublished: v.createdAt || null,
      versionType: /alpha|snapshot/i.test(channel ?? '')
        ? 'alpha'
        : /beta/i.test(channel ?? '')
          ? 'beta'
          : 'release',
      channel,
      gameVersions: v.platformDependencies?.[HANGAR_PLATFORM] ?? [],
      downloadUrl,
      externalUrl,
      external: !downloadUrl && !!externalUrl,
      filename: dl?.fileInfo?.name ?? null,
      sizeBytes: dl?.fileInfo?.sizeBytes ?? null,
      sha256: dl?.fileInfo?.sha256Hash || null,
    };
  }
}
