import {
  Injectable,
  NotFoundException,
  BadGatewayException,
} from '@nestjs/common';
import { ApiCacheService } from './api-cache.service';

// GT New Horizons release-index client.
//
// GTNH is not served by the Modrinth or CurseForge APIs — its releases are
// published as a single JSON index, the same one the itzg image resolves
// against. The index is an OBJECT keyed by version string and ordered
// newest-first; we preserve that order rather than inventing a comparator,
// because beta suffixes ("2.9.0-beta-2") make string ordering unreliable.

const INDEX_URL = 'https://downloads.gtnewhorizons.com/versions.json';
// NOT cosmetic: the download host answers HTTP 403 to requests with no User-Agent.
const UA = 'MinecraftServerManager/0.1 (self-hosted panel; contact via repo)';
const CACHE_KEY = 'gtnh:versions';
const TTL_MS = 30 * 60 * 1000;

/** One normalized GTNH release entry. */
export interface GtnhVersionEntry {
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

@Injectable()
export class GtnhApiService {
  constructor(private readonly cache: ApiCacheService) {}

  readonly INDEX_URL = INDEX_URL;

  /**
   * Pull the changelog link out of an entry's HTML blurb. The index is remote
   * content, so only an https github.com link is trusted enough to render.
   */
  private safeChangelogUrl(description: unknown): string | null {
    const match = /href="([^"]+)"/i.exec(
      typeof description === 'string' ? description : '',
    );
    if (!match) return null;
    try {
      const url = new URL(match[1]!);
      if (url.protocol !== 'https:') return null;
      if (
        url.hostname !== 'github.com' &&
        !url.hostname.endsWith('.github.com')
      )
        return null;
      return url.href;
    } catch {
      return null;
    }
  }

  /**
   * Raw index object → normalized entries, newest-first.
   * Pure: no network, no db — this is the part under test.
   */
  normalizeIndex(raw: unknown): GtnhVersionEntry[] {
    if (!raw || typeof raw !== 'object') return [];
    // No serverUrl here on purpose: the itzg image downloads the pack itself,
    // keyed by GTNH_PACK_VERSION — the panel never fetches the archive.
    return Object.entries(raw as Record<string, RawGtnhEntry>).map(
      ([version, entry]) => {
        const e = entry || {};
        return {
          version,
          channel: /beta/i.test(typeof e.title === 'string' ? e.title : '')
            ? 'beta'
            : 'stable',
          releaseDate: (e.releaseDate as string | undefined) || null,
          maxJavaVersion: Number.isInteger(e.maxJavaVersion)
            ? (e.maxJavaVersion as number)
            : null,
          changelogUrl: this.safeChangelogUrl(e.description),
        };
      },
    );
  }

  filterVersions(
    entries: GtnhVersionEntry[],
    { includeBeta = false }: { includeBeta?: boolean } = {},
  ): GtnhVersionEntry[] {
    return includeBeta
      ? entries
      : entries.filter((e) => e.channel === 'stable');
  }

  pickLatest(
    entries: GtnhVersionEntry[],
    { includeBeta = false }: { includeBeta?: boolean } = {},
  ): GtnhVersionEntry | null {
    return this.filterVersions(entries, { includeBeta })[0] || null;
  }

  /** Fetch + cache the index. Serves the stale copy rather than failing. */
  async fetchIndex(): Promise<GtnhVersionEntry[]> {
    const cached = await this.cache.get(CACHE_KEY);
    const stale = (): GtnhVersionEntry[] | null =>
      cached ? this.normalizeIndex(cached.value) : null;
    if (cached && cached.ageMs < TTL_MS) return stale() as GtnhVersionEntry[];

    let res: Response;
    try {
      res = await fetch(INDEX_URL, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      const stalePart = stale();
      if (stalePart) return stalePart;
      throw new BadGatewayException(
        `Could not reach the GTNH download server (${(err as Error).message})`,
      );
    }
    if (!res.ok) {
      const stalePart = stale();
      if (stalePart) return stalePart;
      throw new BadGatewayException(
        `GTNH download server answered HTTP ${res.status}`,
      );
    }
    let raw: unknown;
    try {
      raw = await res.json();
    } catch (err) {
      const stalePart = stale();
      if (stalePart) return stalePart;
      throw new BadGatewayException(
        `GTNH index is malformed JSON (${(err as Error).message})`,
      );
    }
    this.cache.set(CACHE_KEY, raw);
    return this.normalizeIndex(raw);
  }

  async listVersions({
    includeBeta = false,
  }: { includeBeta?: boolean } = {}): Promise<GtnhVersionEntry[]> {
    return this.filterVersions(await this.fetchIndex(), { includeBeta });
  }

  /** One version by exact key. Unknown keys are a 404 — never passed to container env. */
  async getVersion(version: string): Promise<GtnhVersionEntry> {
    const entry = (await this.fetchIndex()).find((e) => e.version === version);
    if (!entry)
      throw new NotFoundException(`Unknown GTNH pack version: ${version}`);
    return entry;
  }

  async latest({
    includeBeta = false,
  }: { includeBeta?: boolean } = {}): Promise<GtnhVersionEntry | null> {
    return this.pickLatest(await this.fetchIndex(), { includeBeta });
  }
}
