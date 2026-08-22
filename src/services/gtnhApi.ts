'use strict';

// GT New Horizons release-index client.
//
// GTNH is not served by the Modrinth or CurseForge APIs — its releases are
// published as a single JSON index, the same one the itzg image resolves
// against. The index is an OBJECT keyed by version string and ordered
// newest-first; we preserve that order rather than inventing a comparator,
// because beta suffixes ("2.9.0-beta-2") make string ordering unreliable.

import type { Row } from '../db/types';

import { httpError } from '../utils/httpError';
const { dbApi: db } = require('../db') as typeof import('../db');

const INDEX_URL = 'https://downloads.gtnewhorizons.com/versions.json';
// NOT cosmetic: the download host answers HTTP 403 to requests with no User-Agent.
const UA = 'MinecraftServerManager/0.1 (self-hosted panel; contact via repo)';
const CACHE_KEY = 'gtnh:versions';
const TTL_MS = 30 * 60 * 1000;

/** One normalized GTNH release entry. */
interface GtnhVersionEntry {
  version: string;
  channel: 'beta' | 'stable';
  releaseDate: string | null;
  maxJavaVersion: number | null;
  changelogUrl: string | null;
}

/** Shape of one raw entry in the upstream versions.json index. */
interface RawGtnhEntry {
  title?: unknown;
  releaseDate?: unknown;
  maxJavaVersion?: unknown;
  description?: unknown;
}

/**
 * Pull the changelog link out of an entry's HTML blurb. The index is remote
 * content, so only an https github.com link is trusted enough to render.
 */
function safeChangelogUrl(description: unknown): string | null {
  const match = /href="([^"]+)"/i.exec(String(description || ''));
  if (!match) return null;
  try {
    const url = new URL(match[1]!);
    if (url.protocol !== 'https:') return null;
    if (url.hostname !== 'github.com' && !url.hostname.endsWith('.github.com')) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Raw index object → normalized entries, newest-first.
 * Pure: no network, no db — this is the part under test.
 */
function normalizeIndex(raw: unknown): GtnhVersionEntry[] {
  if (!raw || typeof raw !== 'object') return [];
  // No serverUrl here on purpose: the itzg image downloads the pack itself,
  // keyed by GTNH_PACK_VERSION — the panel never fetches the archive.
  return Object.entries(raw as Record<string, RawGtnhEntry>).map(([version, entry]) => {
    const e = entry || {};
    return {
      version,
      channel: (/beta/i.test(String(e.title || '')) ? 'beta' : 'stable') as 'beta' | 'stable',
      releaseDate: (e.releaseDate as string | undefined) || null,
      maxJavaVersion: Number.isInteger(e.maxJavaVersion) ? (e.maxJavaVersion as number) : null,
      changelogUrl: safeChangelogUrl(e.description),
    };
  });
}

function filterVersions(entries: GtnhVersionEntry[], { includeBeta = false }: { includeBeta?: boolean } = {}) {
  return includeBeta ? entries : entries.filter((e) => e.channel === 'stable');
}

function pickLatest(
  entries: GtnhVersionEntry[],
  { includeBeta = false }: { includeBeta?: boolean } = {}
): GtnhVersionEntry | null {
  return filterVersions(entries, { includeBeta })[0] || null;
}

/** Fetch + cache the index. Serves the stale copy rather than failing. */
async function fetchIndex(): Promise<GtnhVersionEntry[]> {
  const cached: Row | undefined = db.get('SELECT value_json, fetched_at FROM api_cache WHERE key = ?', CACHE_KEY);
  const stale = (): GtnhVersionEntry[] | null =>
    cached ? normalizeIndex(JSON.parse(String(cached.value_json))) : null;
  if (cached && Date.now() - Date.parse(String(cached.fetched_at) + 'Z') < TTL_MS) return stale() as GtnhVersionEntry[];

  let res: Response;
  try {
    res = await fetch(INDEX_URL, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    const stalePart = stale();
    if (stalePart) return stalePart;
    throw httpError(502, `Could not reach the GTNH download server (${(err as Error).message})`);
  }
  if (!res.ok) {
    const stalePart = stale();
    if (stalePart) return stalePart;
    throw httpError(502, `GTNH download server answered HTTP ${res.status}`);
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (err) {
    const stalePart = stale();
    if (stalePart) return stalePart;
    throw httpError(502, `GTNH index is malformed JSON (${(err as Error).message})`);
  }
  db.run(
    `INSERT INTO api_cache (key, value_json, fetched_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, fetched_at = excluded.fetched_at`,
    CACHE_KEY,
    JSON.stringify(raw)
  );
  return normalizeIndex(raw);
}

async function listVersions({ includeBeta = false }: { includeBeta?: boolean } = {}): Promise<GtnhVersionEntry[]> {
  return filterVersions(await fetchIndex(), { includeBeta });
}

/** One version by exact key. Unknown keys are a 404 — never passed to container env. */
async function getVersion(version: string): Promise<GtnhVersionEntry> {
  const entry = (await fetchIndex()).find((e) => e.version === version);
  if (!entry) throw httpError(404, `Unknown GTNH pack version: ${version}`);
  return entry;
}

async function latest({ includeBeta = false }: { includeBeta?: boolean } = {}): Promise<GtnhVersionEntry | null> {
  return pickLatest(await fetchIndex(), { includeBeta });
}

// Exported as a single mutable object, not a named-export list: test/checker-
// gtnh.test.js and test/packs-gtnh.test.js stub listVersions/getVersion/latest
// by reassigning properties on this object directly (`gtnhApi.listVersions =
// ...`). A plain `export { listVersions, ... }` list would make esbuild's CJS
// transpilation of named exports define them as read-only getters on
// module.exports (to preserve ESM live-binding semantics), which can't be
// reassigned at all — this object's own properties are ordinary and mutable,
// so stubbing keeps working for every caller that holds a reference to it
// (see src/services/packs.ts's `const gtnhApi = require('./gtnhApi')`).
const gtnhApi = { normalizeIndex, filterVersions, pickLatest, listVersions, getVersion, latest, INDEX_URL };

export { gtnhApi };
