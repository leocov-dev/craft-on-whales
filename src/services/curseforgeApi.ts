'use strict';

// CurseForge API client (requires the user's API key from the encrypted
// store). Docs: https://docs.curseforge.com — Minecraft gameId = 432.

import type { Row } from '../db/types';
import type { CurseforgeMod, CurseforgeFile, CurseforgeResolved } from './types';

import { httpError } from '../utils/httpError';
const db = require('../db') as typeof import('../db');
const apiKeys = require('./apiKeys');

const BASE = 'https://api.curseforge.com/v1';
const GAME_MINECRAFT = 432;
const CLASS_MODS = 6;
const CLASS_MODPACKS = 4471;
const CLASS_PLUGINS = 5;

interface CfFetchOptions {
  search?: Record<string, string | number>;
  ttlMs?: number;
  method?: 'GET' | 'POST';
  body?: unknown;
}

async function cfFetch<T = unknown>(
  pathname: string,
  { search, ttlMs = 10 * 60 * 1000, method = 'GET', body }: CfFetchOptions = {}
): Promise<T> {
  const key: string | null = apiKeys.getKey('curseforge');
  if (!key) throw httpError(412, 'CurseForge API key not set — add it in Settings');

  const url = new URL(BASE + pathname);
  if (search) for (const [k, v] of Object.entries(search)) url.searchParams.set(k, String(v));
  const cacheKey = `curseforge:${method}:${url.pathname}${url.search}:${body ? JSON.stringify(body) : ''}`;
  const cached: Row | undefined =
    method === 'GET' ? db.get('SELECT value_json, fetched_at FROM api_cache WHERE key = ?', cacheKey) : undefined;
  if (cached && Date.now() - Date.parse(String(cached.fetched_at) + 'Z') < ttlMs) {
    return JSON.parse(String(cached.value_json)) as T;
  }
  const res = await fetch(url, {
    method,
    headers: { 'x-api-key': key, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 429) {
    // Rate-limited: a stale cached answer beats a hard failure (same policy
    // as the Modrinth client).
    if (cached) return JSON.parse(String(cached.value_json)) as T;
    throw httpError(429, 'CurseForge rate limit hit — try again in a minute');
  }
  if (res.status === 403) throw httpError(403, 'CurseForge rejected the API key — re-check it in Settings');
  if (res.status === 404) throw httpError(404, 'Not found on CurseForge');
  if (!res.ok) throw httpError(502, `CurseForge answered HTTP ${res.status}`);
  const data = (await res.json()) as T;
  if (method === 'GET') {
    db.run(
      `INSERT INTO api_cache (key, value_json, fetched_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, fetched_at = excluded.fetched_at`,
      cacheKey,
      JSON.stringify(data)
    );
  }
  return data;
}

// Raw shapes as returned by the CurseForge API (only the fields this codebase reads).
interface RawCfLogo {
  thumbnailUrl?: string | null;
  url?: string | null;
}
interface RawCfMod {
  id: number;
  slug: string;
  name: string;
  summary: string;
  logo?: RawCfLogo | null;
  downloadCount: number;
  classId: number;
  latestFiles?: RawCfFile[];
}
interface RawCfDependency {
  modId: number;
  relationType: number;
}
interface RawCfFile {
  id: number;
  displayName: string;
  fileName: string;
  downloadUrl?: string | null;
  gameVersions?: string[];
  releaseType?: number;
  fileDate: string;
  fileLength: number;
  hashes?: unknown[];
  serverPackFileId?: number | null;
  dependencies?: RawCfDependency[];
}

interface SearchParams {
  query?: string;
  kind?: 'mod' | 'modpack' | 'plugin';
  mcVersion?: string;
  loader?: string;
  limit?: number;
  index?: number;
}

/** Search mods or modpacks. */
async function search({
  query = '',
  kind = 'mod',
  mcVersion,
  loader,
  limit = 20,
  index = 0,
}: SearchParams): Promise<CurseforgeMod[]> {
  const classId = kind === 'modpack' ? CLASS_MODPACKS : kind === 'plugin' ? CLASS_PLUGINS : CLASS_MODS;
  const params: Record<string, string | number> = {
    gameId: GAME_MINECRAFT,
    classId,
    searchFilter: query,
    pageSize: limit,
    index,
    sortField: 2,
    sortOrder: 'desc',
  };
  if (mcVersion) params.gameVersion = mcVersion;
  if (loader) params.modLoaderType = loaderTypeId(loader);
  const data = await cfFetch<{ data: RawCfMod[] }>('/mods/search', { search: params, ttlMs: 5 * 60 * 1000 });
  return data.data.map(normalizeMod);
}

async function getMod(modId: number): Promise<CurseforgeMod> {
  const data = await cfFetch<{ data: RawCfMod }>(`/mods/${modId}`);
  return normalizeMod(data.data);
}

/** Look a project up by slug (search with exact slug filter). */
async function getModBySlug(
  slug: string,
  { classId = CLASS_MODPACKS }: { classId?: number } = {}
): Promise<CurseforgeMod | null> {
  const data = await cfFetch<{ data: RawCfMod[] }>('/mods/search', {
    search: { gameId: GAME_MINECRAFT, classId, slug },
  });
  return data.data.length ? normalizeMod(data.data[0]!) : null;
}

/** Files (versions) of a project, newest first, optionally filtered. */
async function getFiles(
  modId: number,
  { mcVersion, loader, pageSize = 50 }: { mcVersion?: string; loader?: string; pageSize?: number } = {}
): Promise<CurseforgeFile[]> {
  const params: Record<string, string | number> = { pageSize };
  if (mcVersion) params.gameVersion = mcVersion;
  if (loader) params.modLoaderType = loaderTypeId(loader);
  const data = await cfFetch<{ data: RawCfFile[] }>(`/mods/${modId}/files`, { search: params, ttlMs: 10 * 60 * 1000 });
  return data.data.map(normalizeFile);
}

async function getFile(modId: number, fileId: number): Promise<CurseforgeFile> {
  const data = await cfFetch<{ data: RawCfFile }>(`/mods/${modId}/files/${fileId}`, { ttlMs: 60 * 60 * 1000 });
  return normalizeFile(data.data);
}

/**
 * Project description as an HTML string (GET /v1/mods/{id}/description).
 * CurseForge serves raw author HTML — callers MUST sanitize before rendering.
 */
async function getDescription(modId: number): Promise<string> {
  const data = await cfFetch<{ data: unknown }>(`/mods/${modId}/description`, { ttlMs: 30 * 60 * 1000 });
  return String(data.data || '');
}

/**
 * Resolve a CurseForge URL/slug to {modId, slug, name, iconUrl, fileId?}.
 * Handles …/minecraft/(mc-mods|modpacks|bukkit-plugins)/<slug>[/files/<fileId>].
 */
async function resolveUrl(input: string): Promise<CurseforgeResolved> {
  const m = /curseforge\.com\/minecraft\/(mc-mods|modpacks|bukkit-plugins)\/([^/]+)(?:\/files\/(\d+))?/.exec(input);
  let slug = input.trim();
  let fileId: number | null = null;
  let classId = CLASS_MODS;
  if (m) {
    classId = m[1] === 'modpacks' ? CLASS_MODPACKS : m[1] === 'bukkit-plugins' ? CLASS_PLUGINS : CLASS_MODS;
    slug = m[2]!;
    fileId = m[3] ? Number(m[3]) : null;
  }
  const mod = /^\d+$/.test(slug)
    ? await getMod(Number(slug))
    : (await getModBySlug(slug, { classId })) || (await getModBySlug(slug, { classId: CLASS_MODS }));
  if (!mod) throw httpError(404, `CurseForge project "${slug}" not found`);
  return { ...mod, fileId };
}

function normalizeMod(m: RawCfMod): CurseforgeMod {
  return {
    modId: m.id,
    slug: m.slug,
    name: m.name,
    summary: m.summary,
    iconUrl: (m.logo && (m.logo.thumbnailUrl || m.logo.url)) || null,
    downloads: m.downloadCount,
    classId: m.classId,
    latestFiles: (m.latestFiles || []).map(normalizeFile),
  };
}

const RELEASE_TYPES: Record<number, 'release' | 'beta' | 'alpha'> = { 1: 'release', 2: 'beta', 3: 'alpha' };

function normalizeFile(f: RawCfFile): CurseforgeFile {
  return {
    fileId: f.id,
    name: f.displayName,
    fileName: f.fileName,
    downloadUrl: f.downloadUrl || null, // null when author disallows API download
    gameVersions: f.gameVersions || [],
    releaseType: (f.releaseType !== undefined && RELEASE_TYPES[f.releaseType]) || 'release',
    fileDate: f.fileDate,
    fileLength: f.fileLength,
    hashes: f.hashes || [],
    serverPackFileId: f.serverPackFileId || null,
    dependencies: (f.dependencies || []).map((d) => ({ modId: d.modId, relation: d.relationType })),
  };
}

const LOADER_TYPE_IDS: Record<string, number> = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };

function loaderTypeId(loader: string): number {
  return LOADER_TYPE_IDS[String(loader).toLowerCase()] || 0;
}

export = { search, getMod, getModBySlug, getFiles, getFile, getDescription, resolveUrl, GAME_MINECRAFT };
