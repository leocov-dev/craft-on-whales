import {
  Injectable,
  NotFoundException,
  HttpException,
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import type { ZodType } from 'zod';
import { ApiCacheService } from './api-cache.service';
import { ConfigService } from '../config/config.service';
import { parseSourceUrl } from './source-url.util';
import type {
  ExpectedHash,
  GithubRelease,
  GithubReleaseAsset,
  GithubRepo,
  GithubRepoRef,
  GithubResolved,
} from './mods.types';
import {
  githubRepoSchema,
  githubReleaseListSchema,
  githubCacheEntrySchema,
  type RawGithubRelease,
} from './github-releases-api.schemas';

const BASE = 'https://api.github.com';
const UA = 'MinecraftServerManager/0.1 (self-hosted panel; contact via repo)';

const NAME_RE = /^[\w.-]+$/;
/** Build sidecars nobody wants installed on a server. */
const SIDECAR_JAR_RE = /-(sources|javadoc|dev|api|slim)\.jar$/i;
const SHA256_DIGEST_RE = /^sha256:([0-9a-f]{64})$/i;

function isName(s: string): boolean {
  return NAME_RE.test(s) && s !== '.' && s !== '..';
}

/**
 * Parse a GitHub URL or `owner/repo` string. Handles
 * `github.com/owner/repo[.git][/releases[/tag/<tag> | /download/<tag>/<asset>]]`.
 * Returns null when the input isn't GitHub-shaped.
 */
export function parseGithubRef(input: string): GithubRepoRef | null {
  const s = input.trim();
  const page = parseSourceUrl(s, 'github.com');
  if (page) {
    const [owner, rawRepo, section, kind, tag, asset] = page.segments;
    const repo = rawRepo?.replace(/\.git$/i, '');
    if (!owner || !repo || !isName(owner) || !isName(repo)) return null;
    const ref: GithubRepoRef = {
      repo: `${owner}/${repo}`,
      tag: null,
      asset: null,
    };
    if (section === 'releases' && kind === 'tag' && tag) ref.tag = tag;
    if (section === 'releases' && kind === 'download' && tag) {
      ref.tag = tag;
      ref.asset = asset ?? null;
    }
    return ref;
  }
  const parts = s.split('/');
  if (parts.length === 2 && parts.every(isName))
    return { repo: s, tag: null, asset: null };
  return null;
}

/** An asset's GitHub-computed sha256, or null when the asset predates digests. */
export function githubAssetExpectedHash(
  asset: GithubReleaseAsset,
): ExpectedHash | null {
  return asset.sha256 ? { algorithm: 'sha256', hex: asset.sha256 } : null;
}

/**
 * The release a person most likely wants: the one with `tag` when given,
 * otherwise the newest stable release that has jar assets, falling back to
 * the newest pre-release with jars. `releases` must be newest-first (as
 * GithubReleasesApiService.getReleases returns them).
 */
export function pickGithubRelease(
  releases: GithubRelease[],
  tag: string | null = null,
): GithubRelease | null {
  if (tag) return releases.find((r) => r.tag === tag) ?? null;
  const withJars = releases.filter((r) => r.assets.length > 0);
  return withJars.find((r) => !r.prerelease) ?? withJars[0] ?? null;
}

/**
 * The asset a person most likely wants: an exact (then substring) match on
 * `preferredName` when given, otherwise the first jar that isn't a
 * sources/javadoc/dev/api/slim sidecar, otherwise the first jar.
 */
export function pickGithubAsset(
  assets: GithubReleaseAsset[],
  preferredName: string | null = null,
): GithubReleaseAsset | null {
  if (preferredName) {
    const match =
      assets.find((a) => a.name === preferredName) ??
      assets.find((a) => a.name.includes(preferredName));
    if (match) return match;
  }
  return assets.find((a) => !SIDECAR_JAR_RE.test(a.name)) ?? assets[0] ?? null;
}

/**
 * The release an installed tag should update to, or null when there's
 * nothing newer. `releases` is newest first. An installed stable release
 * follows pickGithubRelease (newest stable with jars, so pre-releases are
 * skipped); an installed pre-release was a deliberate opt-in and takes the
 * newest release with jars of either kind. Never a downgrade: when the
 * installed tag is in the list, only releases ahead of it count. A tag that
 * has dropped out of the recent-releases window is older than all of them.
 */
export function pickGithubUpdate(
  releases: GithubRelease[],
  installedTag: string | null,
): GithubRelease | null {
  const installedIdx = releases.findIndex((r) => r.tag === installedTag);
  const installed = installedIdx >= 0 ? releases[installedIdx] : undefined;
  const candidate = installed?.prerelease
    ? (releases.find((r) => r.assets.length > 0) ?? null)
    : pickGithubRelease(releases);
  if (!candidate || candidate.tag === installedTag) return null;
  if (installedIdx >= 0 && releases.indexOf(candidate) > installedIdx)
    return null;
  return candidate;
}

/**
 * Which jar of a newer release replaces an installed one: the same asset
 * name (`ProtocolLib.jar`), then the installed name with its version swapped
 * for the new tag's (`Foo-1.2.0.jar` → `Foo-1.3.0.jar`), then pickGithubAsset's
 * default. Keeps a multi-jar release (Paper/Velocity/Fabric variants) on the
 * variant that was installed.
 */
export function pickGithubUpdateAsset(
  assets: GithubReleaseAsset[],
  installedFilename: string | null,
  installedTag: string | null,
  newTag: string,
): GithubReleaseAsset | null {
  const bare = (tag: string) => tag.replace(/^v(?=\d)/i, '');
  const hints: string[] = [];
  if (installedFilename) {
    hints.push(installedFilename);
    const oldVersion = installedTag ? bare(installedTag) : '';
    if (oldVersion && installedFilename.includes(oldVersion))
      hints.push(installedFilename.split(oldVersion).join(bare(newTag)));
  }
  for (const hint of hints) {
    const match = assets.find((a) => a.name === hint);
    if (match) return match;
  }
  return pickGithubAsset(assets);
}

/**
 * GitHub Releases client — many plugins/mods only publish jars as release
 * assets. Keyless for public repos; the unauthenticated 60 req/hr quota is
 * made livable by ETag revalidation (a 304 serves the cache and doesn't count
 * against the limit), and an optional `GITHUB_TOKEN` raises it. See
 * MODS_NOTES.md.
 */
@Injectable()
export class GithubReleasesApiService {
  constructor(
    private readonly cache: ApiCacheService,
    private readonly config: ConfigService,
  ) {}

  private async ghFetch<T>(
    pathname: string,
    schema: ZodType<T>,
    { ttlMs = 10 * 60 * 1000 }: { ttlMs?: number } = {},
  ): Promise<T> {
    const cacheKey = `github:${pathname}`;
    const row = await this.cache.get(cacheKey);
    const parsedEntry = row
      ? githubCacheEntrySchema.safeParse(row.value)
      : null;
    const cached = parsedEntry?.success ? parsedEntry.data : null;
    if (cached && row && row.ageMs < ttlMs) return schema.parse(cached.data);

    const headers: Record<string, string> = {
      'User-Agent': UA,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.config.githubToken)
      headers.Authorization = `Bearer ${this.config.githubToken}`;
    if (cached?.etag) headers['If-None-Match'] = cached.etag;

    const res = await fetch(BASE + pathname, {
      headers,
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 304 && cached) {
      // Revalidated — re-store the same entry so the TTL window restarts.
      void this.cache.set(cacheKey, cached).catch(() => undefined);
      return schema.parse(cached.data);
    }
    const rateLimited =
      res.status === 429 ||
      (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
    if (rateLimited) {
      if (cached) return schema.parse(cached.data); // stale beats a hard failure
      // GitHub's x-ratelimit-reset is an epoch-seconds timestamp.
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const mins =
        Number.isFinite(reset) && reset > 0
          ? Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60000))
          : null;
      throw new HttpException(
        `GitHub rate limit hit${mins ? ` (resets in ~${mins} min)` : ''}` +
          (this.config.githubToken
            ? ''
            : ' — set a GITHUB_TOKEN env var on the panel to raise the quota'),
        429,
      );
    }
    if (res.status === 401)
      throw new ForbiddenException(
        'GitHub rejected the configured GITHUB_TOKEN — check or unset it',
      );
    if (res.status === 403)
      throw new ForbiddenException('GitHub refused access to that repository');
    if (res.status === 404)
      throw new NotFoundException(
        'That repository or release was not found on GitHub',
      );
    if (!res.ok)
      throw new BadGatewayException(`GitHub answered HTTP ${res.status}`);

    const json: unknown = await res.json();
    let data: T;
    try {
      data = schema.parse(json);
    } catch {
      throw new BadGatewayException(
        `GitHub returned an unexpected response shape for ${pathname}`,
      );
    }
    void this.cache
      .set(cacheKey, { etag: res.headers.get('etag'), data: json })
      .catch(() => undefined);
    return data;
  }

  async getRepo(repo: string): Promise<GithubRepo> {
    const r = await this.ghFetch(
      `/repos/${this.assertRepo(repo)}`,
      githubRepoSchema,
      { ttlMs: 30 * 60 * 1000 },
    );
    return {
      repo: r.full_name,
      name: r.name,
      description: r.description || '',
      iconUrl: r.owner?.avatar_url || null,
    };
  }

  /** Published releases, newest first, each with only its `.jar` assets. Drafts are excluded. */
  async getReleases(
    repo: string,
    { limit = 30 }: { limit?: number } = {},
  ): Promise<GithubRelease[]> {
    const perPage = Math.max(1, Math.min(limit, 50));
    const list = await this.ghFetch(
      `/repos/${this.assertRepo(repo)}/releases?per_page=${perPage}`,
      githubReleaseListSchema,
    );
    return list
      .filter((rel) => !rel.draft)
      .map((rel) => this.normalizeRelease(rel));
  }

  /** Resolve a pasted GitHub URL / `owner/repo` to the repo plus any tag/asset it pinned. */
  async resolveUrl(input: string): Promise<GithubResolved> {
    const ref = parseGithubRef(input);
    if (!ref)
      throw new BadRequestException(
        'Could not read a GitHub owner/repo from that input',
      );
    const repo = await this.getRepo(ref.repo);
    return { ...repo, tag: ref.tag, asset: ref.asset };
  }

  private assertRepo(repo: string): string {
    const r = repo.trim();
    const parts = r.split('/');
    if (parts.length !== 2 || !parts.every(isName))
      throw new BadRequestException(
        'Invalid GitHub repository (expected owner/repo)',
      );
    return r;
  }

  private normalizeRelease(rel: RawGithubRelease): GithubRelease {
    return {
      tag: rel.tag_name,
      name: rel.name || rel.tag_name,
      prerelease: rel.prerelease,
      publishedAt: rel.published_at || null,
      htmlUrl: rel.html_url,
      assets: rel.assets
        .filter((a) => /\.jar$/i.test(a.name))
        .map((a) => ({
          name: a.name,
          size: a.size,
          downloadUrl: a.browser_download_url,
          sha256:
            SHA256_DIGEST_RE.exec(a.digest ?? '')?.[1]?.toLowerCase() ?? null,
        })),
    };
  }
}
