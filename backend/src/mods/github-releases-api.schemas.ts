import { z } from 'zod';

// Zod schemas for the GitHub REST API responses GithubReleasesApiService
// reads (https://docs.github.com/en/rest/releases) — only the fields used.

export const githubRepoSchema = z.object({
  full_name: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  owner: z
    .object({ avatar_url: z.string().nullable().optional() })
    .nullable()
    .optional(),
});

const githubAssetSchema = z.object({
  name: z.string(),
  size: z.number(),
  browser_download_url: z.string(),
  // "sha256:<hex>" — GitHub computes this for release assets; older assets
  // may lack it.
  digest: z.string().nullable().optional(),
});

export const githubReleaseSchema = z.object({
  tag_name: z.string(),
  name: z.string().nullable().optional(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  published_at: z.string().nullable().optional(),
  html_url: z.string(),
  assets: z.array(githubAssetSchema),
});

export const githubReleaseListSchema = z.array(githubReleaseSchema);

/**
 * What GithubReleasesApiService stores in `api_cache`: the raw body plus the
 * ETag to revalidate it with (`If-None-Match` → a 304 costs no rate limit).
 */
export const githubCacheEntrySchema = z.object({
  etag: z.string().nullable(),
  data: z.unknown(),
});

export type RawGithubRelease = z.infer<typeof githubReleaseSchema>;
