'use strict';

// Loader BUILD versions for the "From mods" wizard, so a server can pin a
// specific Fabric/Quilt/NeoForge/Forge loader instead of always tracking latest.
// Each source is a public JSON endpoint; results are cached in api_cache and the
// call is best-effort — on any failure we still return a usable "Latest" option
// so the picker never dead-ends. The chosen build maps to the itzg env var:
//   fabric → FABRIC_LOADER_VERSION   quilt → QUILT_LOADER_VERSION
//   neoforge → NEOFORGE_VERSION      forge → FORGE_VERSION
// An empty version means "don't pin" — let the image resolve the latest itself.

import type { Row } from '../db/types';

const db = require('../db') as typeof import('../db');

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_BUILDS = 40; // keep the dropdown sane; power users have the advanced env field

/** One selectable build option in the loader-version dropdown. */
interface LoaderBuild {
  version: string;
  label: string;
}

/** Result of getBuilds(): the full dropdown + which env var a chosen build pins. */
interface LoaderBuildsResult {
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

/** itzg env var that pins this loader's build (null for loaders without one). */
function envKeyFor(loader: string): string | null {
  return ENV_KEY[String(loader).toLowerCase()] || null;
}

async function cachedJson(cacheKey: string, url: string): Promise<unknown> {
  const cached: Row | undefined = db.get('SELECT value_json, fetched_at FROM api_cache WHERE key = ?', cacheKey);
  // SQLite datetime('now') is space-separated; normalize to ISO before parsing.
  if (cached && Date.now() - Date.parse(String(cached.fetched_at).replace(' ', 'T') + 'Z') < TTL_MS) {
    return JSON.parse(String(cached.value_json));
  }
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: unknown = await res.json();
    db.run(
      `INSERT INTO api_cache (key, value_json, fetched_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, fetched_at = excluded.fetched_at`,
      cacheKey,
      JSON.stringify(data)
    );
    return data;
  } catch (err) {
    if (cached) return JSON.parse(String(cached.value_json)); // stale beats nothing
    throw err;
  }
}

interface FabricLoaderVersion {
  version?: string;
  stable?: boolean;
}

// Fabric & Quilt loader versions are independent of the Minecraft version.
async function fabricBuilds(): Promise<LoaderBuild[]> {
  const list = (await cachedJson('loader:fabric', 'https://meta.fabricmc.net/v2/versions/loader')) as
    FabricLoaderVersion[] | null | undefined;
  return (list || [])
    .filter((v): v is Required<Pick<FabricLoaderVersion, 'version'>> & FabricLoaderVersion => Boolean(v && v.version))
    .slice(0, MAX_BUILDS)
    .map((v) => ({ version: v.version, label: v.stable ? `${v.version} (stable)` : v.version }));
}

async function quiltBuilds(): Promise<LoaderBuild[]> {
  const list = (await cachedJson('loader:quilt', 'https://meta.quiltmc.org/v3/versions/loader')) as
    FabricLoaderVersion[] | null | undefined;
  return (list || [])
    .filter((v): v is Required<Pick<FabricLoaderVersion, 'version'>> & FabricLoaderVersion => Boolean(v && v.version))
    .slice(0, MAX_BUILDS)
    .map((v) => ({ version: v.version, label: v.version }));
}

/** NeoForge encodes the MC version in its build: 1.21.1 → "21.1.x", 1.21 → "21.0.x". */
function neoforgePrefix(mc: string | null | undefined): string | null {
  const m = /^1\.(\d+)(?:\.(\d+))?$/.exec(String(mc || ''));
  return m ? `${m[1]}.${m[2] || '0'}.` : null;
}

async function neoforgeBuilds(mc: string | null | undefined): Promise<LoaderBuild[]> {
  const data = (await cachedJson(
    'loader:neoforge',
    'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge'
  )) as { versions?: string[] };
  const all = (data.versions || []).slice().reverse(); // maven returns ascending; newest first
  const prefix = neoforgePrefix(mc);
  const matched = prefix ? all.filter((v) => v.startsWith(prefix)) : all;
  return matched.slice(0, MAX_BUILDS).map((v) => ({ version: v, label: /-beta$/i.test(v) ? `${v} (beta)` : v }));
}

// Forge's promotions feed only surfaces the recommended + latest build per MC —
// that covers what almost everyone pins; the advanced FORGE_VERSION field remains
// for arbitrary builds.
async function forgeBuilds(mc: string | null | undefined): Promise<LoaderBuild[]> {
  const data = (await cachedJson(
    'loader:forge',
    'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'
  )) as { promos?: Record<string, string> };
  const promos = data.promos || {};
  const recommended = promos[`${mc}-recommended`];
  const latest = promos[`${mc}-latest`];
  const builds: LoaderBuild[] = [];
  if (recommended) builds.push({ version: recommended, label: `${recommended} (recommended)` });
  if (latest && latest !== recommended) builds.push({ version: latest, label: `${latest} (latest)` });
  return builds;
}

/**
 * Build list for a loader (+ MC where the loader is MC-specific). Always starts
 * with the "Latest" no-pin option, then specific builds newest-first when the
 * registry is reachable. Never throws — a failed fetch yields the Latest option.
 */
async function getBuilds(loader: string, mc: string | null | undefined): Promise<LoaderBuildsResult> {
  const key = String(loader).toLowerCase();
  let builds: LoaderBuild[] = [];
  try {
    if (key === 'fabric') builds = await fabricBuilds();
    else if (key === 'quilt') builds = await quiltBuilds();
    else if (key === 'neoforge') builds = await neoforgeBuilds(mc);
    else if (key === 'forge') builds = await forgeBuilds(mc);
  } catch {
    builds = []; // best-effort — fall through to Latest-only
  }
  return { loader: key, envKey: envKeyFor(key), builds: [LATEST, ...builds], default: '' };
}

export = { getBuilds, envKeyFor };
