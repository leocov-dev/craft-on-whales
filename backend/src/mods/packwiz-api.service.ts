import {
  Injectable,
  BadRequestException,
  BadGatewayException,
} from '@nestjs/common';
import * as crypto from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { safeFetch } from '../utils/url-guard';
import type {
  PackwizPackToml,
  PackwizIndexToml,
  PackwizModToml,
  PackwizResolved,
  PackwizModInfo,
} from './mods.types';

const UA = 'MinecraftServerManager/0.1 (self-hosted panel; contact via repo)';
// packwiz packs can list 100+ mods; fetch their metafiles in small batches
// rather than one-at-a-time (slow) or all-at-once (thundering herd against
// the pack host, which is often a plain static file server or GitHub raw).
const METAFILE_FETCH_CONCURRENCY = 8;

async function fetchText(url: string): Promise<string> {
  let res: Response;
  try {
    res = await safeFetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    if (
      err instanceof BadRequestException ||
      err instanceof BadGatewayException
    )
      throw err;
    throw new BadGatewayException(`Could not reach ${url}`);
  }
  if (!res.ok)
    throw new BadGatewayException(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

/**
 * packwiz client: fetch + parse `pack.toml` -> `index.toml` -> per-mod
 * `*.toml`. Unlike ModrinthApiService/CurseforgeApiService there is no
 * search API and no version registry — packwiz packs are identified purely
 * by URL, and "the current version" is whatever the URL currently serves.
 * Every fetch is a user-supplied URL, so every fetch goes through the
 * SSRF-guarded `safeFetch`, never plain `fetch`.
 */
@Injectable()
export class PackwizApiService {
  /** Resolve a `pack.toml` URL relative to another packwiz file's URL. */
  private resolveRelative(baseUrl: string, relPath: string): string {
    return new URL(relPath, baseUrl).toString();
  }

  private parse<T>(text: string, what: string): T {
    try {
      return parseToml(text) as T;
    } catch {
      throw new BadRequestException(
        `Could not parse ${what} as TOML — is this really a packwiz pack.toml URL?`,
      );
    }
  }

  /** Fetch + parse `pack.toml`, then its referenced `index.toml`, and hash the index for pinning. */
  async resolvePack(packUrl: string): Promise<PackwizResolved> {
    const packText = await fetchText(packUrl);
    const pack = this.parse<PackwizPackToml>(packText, 'pack.toml');
    if (
      !pack.name ||
      !pack['pack-format'] ||
      !pack.index?.file ||
      !pack.versions?.minecraft
    ) {
      throw new BadRequestException(
        'This does not look like a packwiz pack.toml (missing name/pack-format/index/versions)',
      );
    }
    const indexUrl = this.resolveRelative(packUrl, pack.index.file);
    const indexText = await fetchText(indexUrl);
    const index = this.parse<PackwizIndexToml>(indexText, 'index.toml');
    const indexHash = crypto
      .createHash('sha256')
      .update(indexText)
      .digest('hex');
    return { packUrl, pack, indexText, index, indexHash };
  }

  /** List the mods referenced by an already-resolved pack's index. Best-effort: a mod whose metafile can't be fetched is skipped, not fatal. */
  async listMods(resolved: PackwizResolved): Promise<PackwizModInfo[]> {
    const indexUrl = this.resolveRelative(
      resolved.packUrl,
      resolved.pack.index.file,
    );
    const metafiles = (resolved.index.files || []).filter((f) => f.metafile);
    const mods: PackwizModInfo[] = [];
    for (let i = 0; i < metafiles.length; i += METAFILE_FETCH_CONCURRENCY) {
      const batch = metafiles.slice(i, i + METAFILE_FETCH_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (entry) => {
          const modUrl = this.resolveRelative(indexUrl, entry.file);
          const text = await fetchText(modUrl);
          const mod = this.parse<PackwizModToml>(text, entry.file);
          return mod;
        }),
      );
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const mod = r.value;
        mods.push({
          name: mod.name,
          filename: mod.filename,
          side: mod.side || 'both',
          updatePlatform: mod.update?.curseforge
            ? 'curseforge'
            : mod.update?.modrinth
              ? 'modrinth'
              : null,
        });
      }
    }
    return mods.sort((a, b) => a.name.localeCompare(b.name));
  }
}
