'use strict';

// Modrinth public API client (no key required). Cached + rate-limit friendly.
// Docs: https://docs.modrinth.com/api

import type { Row } from '../db/types';
import type { ModrinthSearchHit, ModrinthResolved, ModrinthProject, ModrinthVersion, ModrinthFile } from './types';

import { httpError } from '../utils/httpError';
const { dbApi: db } = require('../db') as typeof import('../db');

const BASE = 'https://api.modrinth.com/v2';
const UA = 'MinecraftServerManager/0.1 (self-hosted panel; contact via repo)';

interface MrFetchOptions {
  ttlMs?: number;
  search?: Record<string, string>;
}

async function mrFetch<T = unknown>(
  pathname: string,
  { ttlMs = 10 * 60 * 1000, search }: MrFetchOptions = {}
): Promise<T> {
  const url = new URL(BASE + pathname);
  if (search) for (const [k, v] of Object.entries(search)) url.searchParams.set(k, v);
  const cacheKey = `modrinth:${url.pathname}${url.search}`;
  const cached: Row | undefined = db.get('SELECT value_json, fetched_at FROM api_cache WHERE key = ?', cacheKey);
  if (cached && Date.now() - Date.parse(String(cached.fetched_at) + 'Z') < ttlMs) {
    return JSON.parse(String(cached.value_json)) as T;
  }
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 429) {
    if (cached) return JSON.parse(String(cached.value_json)) as T;
    throw httpError(429, 'Modrinth rate limit hit — try again in a minute');
  }
  if (res.status === 404) throw httpError(404, 'Not found on Modrinth');
  if (!res.ok) throw httpError(502, `Modrinth answered HTTP ${res.status}`);
  const data = (await res.json()) as T;
  db.run(
    `INSERT INTO api_cache (key, value_json, fetched_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, fetched_at = excluded.fetched_at`,
    cacheKey,
    JSON.stringify(data)
  );
  return data;
}

interface ModrinthSearchHitRaw {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  icon_url?: string | null;
  downloads: number;
  categories: string[];
  latest_version: string;
}

interface SearchParams {
  query?: string;
  kind?: 'mod' | 'plugin' | 'datapack' | 'resourcepack' | 'modpack';
  loader?: string;
  mcVersion?: string;
  limit?: number;
  offset?: number;
}

/**
 * Search projects. kind: 'mod' | 'plugin' | 'datapack' | 'resourcepack' | 'modpack'
 * loader/mcVersion narrow via facets.
 */
async function search({
  query = '',
  kind = 'mod',
  loader,
  mcVersion,
  limit = 20,
  offset = 0,
}: SearchParams): Promise<ModrinthSearchHit[]> {
  const facets: string[][] = [];
  if (kind === 'plugin')
    facets.push(['categories:paper', 'categories:spigot', 'categories:bukkit', 'categories:purpur']);
  else if (kind) facets.push([`project_type:${kind}`]);
  if (loader && kind !== 'plugin') facets.push([`categories:${loader.toLowerCase()}`]);
  if (mcVersion) facets.push([`versions:${mcVersion}`]);
  const data = await mrFetch<{ hits: ModrinthSearchHitRaw[] }>('/search', {
    search: { query, limit: String(limit), offset: String(offset), index: 'relevance', facets: JSON.stringify(facets) },
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

function getProject(idOrSlug: string): Promise<ModrinthProject> {
  return mrFetch<ModrinthProject>(`/project/${encodeURIComponent(idOrSlug)}`, { ttlMs: 30 * 60 * 1000 });
}

/** Version list filtered to the server's loader + MC version. */
async function getVersions(
  idOrSlug: string,
  { loader, mcVersion }: { loader?: string; mcVersion?: string } = {}
): Promise<ModrinthVersion[]> {
  const search: Record<string, string> = {};
  if (loader) search.loaders = JSON.stringify([loader.toLowerCase()]);
  if (mcVersion) search.game_versions = JSON.stringify([mcVersion]);
  return mrFetch<ModrinthVersion[]>(`/project/${encodeURIComponent(idOrSlug)}/version`, {
    search,
    ttlMs: 10 * 60 * 1000,
  });
}

function getVersion(versionId: string): Promise<ModrinthVersion> {
  return mrFetch<ModrinthVersion>(`/version/${encodeURIComponent(versionId)}`, { ttlMs: 60 * 60 * 1000 });
}

/**
 * Resolve any Modrinth URL (or slug) to {projectId, slug, versionId?}.
 * Handles /mod|plugin|datapack|resourcepack|modpack/<slug>[/version/<ver>].
 */
async function resolveUrl(input: string): Promise<ModrinthResolved> {
  let slug = input.trim();
  let versionRef: string | null = null;
  const m = /modrinth\.com\/(?:mod|plugin|datapack|resourcepack|modpack)\/([^/]+)(?:\/version\/([^/?#]+))?/.exec(input);
  if (m) {
    slug = m[1]!;
    versionRef = m[2] || null;
  }
  const project = await getProject(slug);
  let versionId: string | null = null;
  if (versionRef) {
    const versions = await mrFetch<ModrinthVersion[]>(`/project/${project.id}/version`, { ttlMs: 10 * 60 * 1000 });
    const v = versions.find((x) => x.id === versionRef || x.version_number === decodeURIComponent(versionRef!));
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
function primaryFile(version: ModrinthVersion): ModrinthFile {
  return version.files.find((f) => f.primary) || version.files[0]!;
}

export { search, getProject, getVersions, getVersion, resolveUrl, primaryFile };
