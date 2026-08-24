import { Injectable, NotFoundException } from '@nestjs/common';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';
import { eq } from 'drizzle-orm';
import { DbService } from '../db/db.service';
import { PathGuardService } from '../storage/path-guard.service';
import { ServerQueryService } from '../servers/server-query.service';
import { apiCache } from '../db/schema';
import {
  LANG_RE,
  META_RE,
  NESTED_SERVER_RE,
  pickZipEntries,
  parseModsToml,
  parseFabricModJson,
  parseLang,
  nearestVersion,
  blockNamesFrom,
  mcDataItemsToLangEntries,
} from './item-zip-parser';
import type {
  LangEntry,
  McDataBlock,
  McDataItem,
  Registry,
  RegistryModSummary,
  SearchParams,
} from './item-registry.types';

const CACHE_PREFIX = 'item-registry:';
const JAR_CONCURRENCY = 8;

// Official Mojang SERVER jars (plain or the modern "bundler" form) never ship
// assets/ — no lang files, no textures, that's client-jar-only. So on a
// vanilla (or vanilla-based) server, readVanillaLang() finds nothing and
// every minecraft:* item would be silently missing from the registry. This
// offline-cached, MC-version-keyed fallback (PrismarineJS/minecraft-data,
// MIT) fills that gap without needing the client jar.
const MCDATA_BASE =
  'https://cdn.jsdelivr.net/gh/PrismarineJS/minecraft-data@master/data/pc';
const MCDATA_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MCDATA_VERSIONS_TTL_MS = 24 * 60 * 60 * 1000;
const MCDATA_VERSIONS_URL =
  'https://api.github.com/repos/PrismarineJS/minecraft-data/contents/data/pc';

// Item/block icons: served locally from public/icons/mc-items/ instead of an
// external CDN — a self-hosted panel commonly sits behind a reverse proxy or
// restrictive firewall a client-side <img> to a third-party CDN may never
// reach. Mod items have no bundled icon (the source data is vanilla-only).
const ICON_BASE = '/icons/mc-items';

/**
 * JEI-style item registry. The list of every givable item/block on a server
 * is derived primarily from the server's OWN files (mod jars' lang files +
 * the vanilla server jar when it happens to carry assets/, falling back to
 * an offline-cached minecraft-data snapshot otherwise) — see
 * `src/services/itemRegistry.ts` in the legacy repo for the full design
 * rationale, ported here verbatim.
 *
 * Building means opening ~hundreds of zips, so the result is persisted in
 * `api_cache` under `item-registry:<serverId>` together with a fingerprint
 * of the inputs; a per-process Map avoids re-parsing the JSON blob on every
 * request.
 */
@Injectable()
export class ItemRegistryService {
  private readonly memory = new Map<
    string,
    { fingerprint: string; registry: Registry }
  >();

  constructor(
    private readonly dbService: DbService,
    private readonly pathGuard: PathGuardService,
    private readonly serverQuery: ServerQueryService,
  ) {}

  private get db() {
    return this.dbService.db;
  }

  iconBaseUrl(): string {
    return ICON_BASE;
  }

  // -------------------------------------------------------------------------
  // api_cache-backed generic fetch cache

  private async cachedJson(
    cacheKey: string,
    url: string,
    ttlMs: number,
  ): Promise<unknown> {
    const [cached] = await this.db
      .select()
      .from(apiCache)
      .where(eq(apiCache.key, cacheKey))
      .limit(1);
    if (
      cached &&
      Date.now() - Date.parse(cached.fetchedAt.replace(' ', 'T') + 'Z') < ttlMs
    ) {
      return JSON.parse(cached.valueJson);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: unknown = await res.json();
      await this.db
        .insert(apiCache)
        .values({ key: cacheKey, valueJson: JSON.stringify(data) })
        .onConflictDoUpdate({
          target: apiCache.key,
          set: {
            valueJson: JSON.stringify(data),
            fetchedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
          },
        });
      return data;
    } catch (err) {
      if (cached) return JSON.parse(cached.valueJson); // stale beats nothing
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // vanilla server jar discovery

  /** Candidate vanilla jar paths for a server, best-first. */
  private async vanillaJarCandidates(serverId: string): Promise<string[]> {
    const base = this.pathGuard.dataPath('servers', serverId);
    const candidates: string[] = [];

    // Top-level jars (vanilla / custom: server.jar, minecraft_server*.jar, …)
    try {
      for (const e of await fsp.readdir(base, { withFileTypes: true })) {
        if (e.isFile() && e.name.toLowerCase().endsWith('.jar'))
          candidates.push(path.join(base, e.name));
      }
    } catch {
      /* server dir gone */
    }

    // Forge/NeoForge: libraries/net/minecraft/server/<version>/*.jar
    const libDir = path.join(base, 'libraries', 'net', 'minecraft', 'server');
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 3) return;
      let entries: Dirent[] = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) await walk(abs, depth + 1);
        else if (e.isFile() && e.name.endsWith('.jar')) candidates.push(abs);
      }
    };
    await walk(libDir, 0);

    // Paper-family keeps the Mojang jar under cache/.
    await walk(path.join(base, 'cache'), 0);

    // Largest first — the full server jar dwarfs slim/extra variants.
    const sized: { abs: string; size: number }[] = [];
    for (const abs of candidates) {
      try {
        sized.push({ abs, size: (await fsp.stat(abs)).size });
      } catch {
        /* raced */
      }
    }
    sized.sort((a, b) => b.size - a.size);
    return sized.map((c) => c.abs);
  }

  /**
   * Find and parse the vanilla lang file. Handles both plain jars (assets at
   * the top level) and Mojang bundler jars (real jar nested under
   * META-INF/versions).
   */
  private async readVanillaLang(
    serverId: string,
  ): Promise<{ entries: LangEntry[]; jarPath: string } | null> {
    for (const jarPath of await this.vanillaJarCandidates(serverId)) {
      try {
        const found = await pickZipEntries(
          jarPath,
          (n) => LANG_RE.test(n) || NESTED_SERVER_RE.test(n),
          (f) => [...f.keys()].some((n) => LANG_RE.test(n)),
        );
        const direct = [...found.entries()].find(([n]) => LANG_RE.test(n));
        if (direct) return { entries: parseLang(direct[1]), jarPath };

        const nested = [...found.entries()].find(([n]) =>
          NESTED_SERVER_RE.test(n),
        );
        if (nested) {
          const inner = await pickZipEntries(
            nested[1],
            (n) => LANG_RE.test(n),
            (f) => f.size > 0,
          );
          const lang = [...inner.values()][0];
          if (lang) return { entries: parseLang(lang), jarPath };
        }
      } catch {
        /* not a readable zip / no assets — try the next candidate */
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // minecraft-data fallback (vanilla items when the server jar has no assets/)

  private async fetchMcData(
    version: string,
  ): Promise<{ items: McDataItem[]; blocks: McDataBlock[] }> {
    const [items, blocks] = await Promise.all([
      this.cachedJson(
        `mcdata:items:${version}`,
        `${MCDATA_BASE}/${version}/items.json`,
        MCDATA_TTL_MS,
      ),
      this.cachedJson(
        `mcdata:blocks:${version}`,
        `${MCDATA_BASE}/${version}/blocks.json`,
        MCDATA_TTL_MS,
      ),
    ]);
    return { items: items as McDataItem[], blocks: blocks as McDataBlock[] };
  }

  /** minecraft-data's version folders that actually carry real per-version
   *  data (`latest` is a red herring — it only holds protocol.yml). */
  private async listMcDataVersions(): Promise<string[]> {
    const entries = (await this.cachedJson(
      'mcdata:versions',
      MCDATA_VERSIONS_URL,
      MCDATA_VERSIONS_TTL_MS,
    )) as {
      type: string;
      name: string;
    }[];
    return entries
      .filter((e) => e.type === 'dir' && /^\d+\.\d+(\.\d+)?$/.test(e.name))
      .map((e) => e.name);
  }

  /**
   * Vanilla item/block entries for a server's MC version, sourced from
   * minecraft-data instead of the (assets-less) server jar. Never throws —
   * an unreachable network just means vanilla items stay absent.
   */
  private async fetchVanillaFallback(
    mcVersion: string | null | undefined,
  ): Promise<LangEntry[] | null> {
    const raw = String(mcVersion || '').trim();
    let version = raw && raw.toUpperCase() !== 'LATEST' ? raw : '';
    try {
      const available = await this.listMcDataVersions();
      version = nearestVersion(version, available) || version;
    } catch {
      /* directory listing unreachable — fall through and try the raw string as-is */
    }
    if (!version) return null;
    let data: { items: McDataItem[]; blocks: McDataBlock[] };
    try {
      data = await this.fetchMcData(version);
    } catch {
      return null;
    }
    return mcDataItemsToLangEntries(data.items, blockNamesFrom(data.blocks));
  }

  // -------------------------------------------------------------------------
  // fingerprint — cheap change detection over the inputs

  private async computeFingerprint(serverId: string): Promise<string> {
    const modsDir = this.pathGuard.dataPath('servers', serverId, 'mods');
    let count = 0;
    let totalSize = 0;
    let maxMtime = 0;
    try {
      for (const e of await fsp.readdir(modsDir, { withFileTypes: true })) {
        if (!e.isFile() || !e.name.toLowerCase().endsWith('.jar')) continue;
        try {
          const st = await fsp.stat(path.join(modsDir, e.name));
          count += 1;
          totalSize += st.size;
          if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
        } catch {
          /* raced deletion */
        }
      }
    } catch {
      /* no mods dir — vanilla server */
    }

    // Vanilla jar identity: the best candidate's path + size (mtime shifts on
    // container reinstalls without content changes, so path+size is enough).
    let vanilla = 'none';
    const cands = await this.vanillaJarCandidates(serverId);
    if (cands.length) {
      try {
        const st = await fsp.stat(cands[0]!);
        vanilla = `${path.relative(this.pathGuard.dataPath('servers', serverId), cands[0]!)}:${st.size}`;
      } catch {
        /* raced */
      }
    }
    // A server with no on-disk vanilla jar yet (never started) has no jar
    // identity to key off — mc_version explicitly, so switching it pre-launch
    // still invalidates the (otherwise empty) cached registry.
    const server = await this.serverQuery.getServer(serverId);
    const mcVersion = server?.mc_version || '';
    return `v2|${count}|${totalSize}|${Math.round(maxMtime)}|${vanilla}|${mcVersion}`;
  }

  // -------------------------------------------------------------------------
  // build

  /** Scan every mod jar + the vanilla server jar and build the registry. */
  async buildRegistry(
    serverId: string,
    {
      onProgress = () => {},
    }: {
      onProgress?: (done: number, total: number, label?: string) => void;
    } = {},
  ): Promise<Registry> {
    const server = await this.serverQuery.getServer(serverId);
    if (!server) throw new NotFoundException('Server not found');

    const started = Date.now();
    const fingerprint = await this.computeFingerprint(serverId);
    const byId = new Map<
      string,
      { id: string; name: string; mod: string; kind: 'item' | 'block' }
    >();
    const modNames = new Map<string, string>(); // ns -> display name

    // Vanilla first so mod-shipped assets/minecraft overrides never shadow it.
    const vanilla = await this.readVanillaLang(serverId);
    if (vanilla) {
      for (const e of vanilla.entries) {
        if (!byId.has(e.id))
          byId.set(e.id, {
            id: e.id,
            name: e.name,
            mod: 'Minecraft',
            kind: e.kind,
          });
      }
      modNames.set('minecraft', 'Minecraft');
    } else {
      // Server jars (vanilla or otherwise) never ship a client's assets/ —
      // fall back to the offline-cached, version-keyed vanilla list.
      const fallback = await this.fetchVanillaFallback(server.mc_version).catch(
        () => null,
      );
      if (fallback) {
        for (const e of fallback) {
          if (!byId.has(e.id))
            byId.set(e.id, {
              id: e.id,
              name: e.name,
              mod: 'Minecraft',
              kind: e.kind,
            });
        }
        modNames.set('minecraft', 'Minecraft');
      }
    }

    const modsDir = this.pathGuard.dataPath('servers', serverId, 'mods');
    let jars: string[] = [];
    try {
      jars = (await fsp.readdir(modsDir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.jar'))
        .map((e) => e.name)
        .sort();
    } catch {
      /* vanilla server — no mods dir */
    }

    let done = 0;
    const scanJar = async (name: string): Promise<void> => {
      let found: Map<string, Buffer>;
      try {
        found = await pickZipEntries(
          path.join(modsDir, name),
          (n) => LANG_RE.test(n) || META_RE.test(n),
        );
      } catch {
        return; // corrupt/unreadable jar — never fatal
      } finally {
        done += 1;
        onProgress(done, jars.length, name);
      }

      // Jar-level display names: modId -> name from whichever metadata is present.
      const jarNames = new Map<string, string | null>();
      for (const [entryName, buf] of found) {
        if (entryName.endsWith('mods.toml')) {
          for (const [k, v] of parseModsToml(String(buf))) jarNames.set(k, v);
        } else if (
          entryName === 'fabric.mod.json' ||
          entryName === 'quilt.mod.json'
        ) {
          for (const [k, v] of parseFabricModJson(buf)) jarNames.set(k, v);
        }
      }
      const fallbackName = [...jarNames.values()].find(Boolean) || null;

      for (const [entryName, buf] of found) {
        const langMatch = LANG_RE.exec(entryName);
        if (!langMatch) continue;
        const ns = langMatch[1]!.toLowerCase();
        const display = jarNames.get(ns) || fallbackName || ns;
        if (!modNames.has(ns) || modNames.get(ns) === ns)
          modNames.set(ns, display);
        for (const e of parseLang(buf)) {
          if (!byId.has(e.id)) {
            byId.set(e.id, {
              id: e.id,
              name: e.name,
              mod: modNames.get(e.ns) || display,
              kind: e.kind,
            });
          }
          if (!modNames.has(e.ns))
            modNames.set(e.ns, e.ns === ns ? display : e.ns);
        }
      }
    };

    // Bounded parallelism — ~200 jars on big packs, 8 at a time keeps FDs sane.
    const queue = [...jars];
    await Promise.all(
      Array.from({ length: JAR_CONCURRENCY }, async () => {
        while (queue.length) {
          const name = queue.shift();
          if (name) await scanJar(name);
        }
      }),
    );

    // Re-resolve mod display names (a lang file may have been scanned before
    // the jar that declares its namespace's pretty name).
    const items = [...byId.values()];
    for (const item of items) {
      const ns = item.id.split(':')[0]!;
      item.mod = modNames.get(ns) || ns;
    }
    items.sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );

    const modCounts = new Map<string, number>();
    for (const item of items) {
      const ns = item.id.split(':')[0]!;
      modCounts.set(ns, (modCounts.get(ns) || 0) + 1);
    }
    const mods: RegistryModSummary[] = [...modCounts.entries()]
      .map(([ns, count]) => ({ id: ns, name: modNames.get(ns) || ns, count }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const registry: Registry = {
      items,
      mods,
      builtAt: Date.now(),
      buildMs: Date.now() - started,
      fingerprint,
      vanillaJar: vanilla
        ? path
            .relative(
              this.pathGuard.dataPath('servers', serverId),
              vanilla.jarPath,
            )
            .replace(/\\/g, '/')
        : null,
      jarCount: jars.length,
    };

    const cacheKey = CACHE_PREFIX + serverId;
    const valueJson = JSON.stringify(registry);
    await this.db
      .insert(apiCache)
      .values({ key: cacheKey, valueJson })
      .onConflictDoUpdate({
        target: apiCache.key,
        set: {
          valueJson,
          fetchedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
        },
      });
    this.memory.set(serverId, { fingerprint, registry });
    return registry;
  }

  // -------------------------------------------------------------------------
  // cached access

  /**
   * Registry for a server: in-process cache → api_cache row → full build. The
   * fingerprint (jar count/size/mtime + vanilla jar) is re-checked every
   * call — it's a directory stat sweep, so cache hits stay in the low
   * milliseconds.
   */
  async getRegistry(
    serverId: string,
    {
      force = false,
      onProgress,
    }: {
      force?: boolean;
      onProgress?: (done: number, total: number, label?: string) => void;
    } = {},
  ): Promise<Registry> {
    const fingerprint = await this.computeFingerprint(serverId);
    if (!force) {
      const mem = this.memory.get(serverId);
      if (mem && mem.fingerprint === fingerprint) return mem.registry;

      const [row] = await this.db
        .select()
        .from(apiCache)
        .where(eq(apiCache.key, CACHE_PREFIX + serverId))
        .limit(1);
      if (row) {
        try {
          const registry = JSON.parse(row.valueJson) as Registry;
          if (registry.fingerprint === fingerprint) {
            this.memory.set(serverId, { fingerprint, registry });
            return registry;
          }
        } catch {
          /* corrupt cache row — rebuild */
        }
      }
    }
    return this.buildRegistry(serverId, { onProgress });
  }

  /** [{id: namespace, name: display, count}] for the mod filter dropdown. */
  async getMods(serverId: string): Promise<RegistryModSummary[]> {
    return (await this.getRegistry(serverId)).mods;
  }

  // -------------------------------------------------------------------------
  // search

  /**
   * Search the registry. q matches display name OR id (case-insensitive
   * substring). Rank: exact id > name starts-with > name contains > id
   * contains.
   */
  async search(
    serverId: string,
    { q = '', mod = '', kind = '', limit = 100, offset = 0 }: SearchParams = {},
  ): Promise<{ items: Registry['items']; total: number }> {
    const registry = await this.getRegistry(serverId);
    const needle = String(q || '')
      .trim()
      .toLowerCase();
    const modNs = String(mod || '')
      .trim()
      .toLowerCase();
    const wantKind = kind === 'item' || kind === 'block' ? kind : null;

    const scored: [number, Registry['items'][number]][] = [];
    for (const item of registry.items) {
      if (wantKind && item.kind !== wantKind) continue;
      if (modNs && !item.id.startsWith(modNs + ':')) continue;
      if (!needle) {
        scored.push([2, item]); // no query — keep alphabetical registry order
        continue;
      }
      const id = item.id.toLowerCase();
      const name = item.name.toLowerCase();
      let rank: number;
      if (id === needle || id === `minecraft:${needle}`) rank = 0;
      else if (name.startsWith(needle)) rank = 1;
      else if (name.includes(needle)) rank = 2;
      else if (id.includes(needle)) rank = 3;
      else continue;
      scored.push([rank, item]);
    }
    if (needle)
      scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name));

    const total = scored.length;
    const start = Math.max(0, Math.trunc(offset) || 0);
    const n = Math.min(500, Math.max(1, Math.trunc(limit) || 100));
    return {
      items: scored.slice(start, start + n).map(([, item]) => item),
      total,
    };
  }
}
