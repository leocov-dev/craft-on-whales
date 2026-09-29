import {
  Injectable,
  Logger,
  PreconditionFailedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ModrinthApiService } from './modrinth-api.service';
import { CurseforgeApiService } from './curseforge-api.service';
import { curseforgeFingerprint } from './curseforge-fingerprint';
import { readJarMetadata } from './jar-metadata-reader';
import type {
  CurseforgeFingerprintMatch,
  CurseforgeMod,
  IdentifiedJar,
  JarInput,
  ModrinthProject,
  ModrinthVersionWithProject,
} from './mods.types';

// Loaders that mark a registry file as a server plugin rather than a mod.
const PLUGIN_LOADERS = new Set([
  'bukkit',
  'spigot',
  'paper',
  'purpur',
  'folia',
  'velocity',
  'bungeecord',
  'waterfall',
]);
const MOD_LOADERS = new Set(['forge', 'neoforge', 'fabric', 'quilt']);
const CF_CLASS_PLUGINS = 5;
const MC_VERSION_RE = /^\d+\.\d+(?:\.\d+)?$/;

/** CurseForge's `gameVersions` mixes MC versions, loaders and other tags ("Server", "Java 17"). */
export function splitCurseforgeGameVersions(gameVersions: string[]): {
  mcVersions: string[];
  loaders: string[];
} {
  const mcVersions: string[] = [];
  const loaders: string[] = [];
  for (const v of gameVersions) {
    const lower = v.toLowerCase();
    if (MC_VERSION_RE.test(v)) mcVersions.push(v);
    else if (MOD_LOADERS.has(lower) || PLUGIN_LOADERS.has(lower))
      loaders.push(lower);
  }
  return { mcVersions, loaders };
}

function kindFromLoaders(loaders: string[]): 'mod' | 'plugin' {
  return loaders.length > 0 && loaders.every((l) => PLUGIN_LOADERS.has(l))
    ? 'plugin'
    : 'mod';
}

function unidentified({ filename, data }: JarInput): IdentifiedJar {
  return {
    filename,
    size: data.length,
    sha1: createHash('sha1').update(data).digest('hex'),
    sha256: createHash('sha256').update(data).digest('hex'),
    fingerprint: curseforgeFingerprint(data),
    source: 'unknown',
    platform: null,
    projectId: null,
    versionId: null,
    slug: null,
    name: filename.replace(/\.jar$/i, '') || filename,
    version: null,
    iconUrl: null,
    loaders: [],
    mcVersions: [],
    mcConstraint: null,
    kind: null,
  };
}

/**
 * Works out what a mod/plugin jar is, so an uploaded or zip-imported jar can
 * be tracked like a registry install instead of as an anonymous file.
 * Three layers, best first, each only for jars the previous ones missed:
 *
 *  1. Modrinth reverse lookup by sha1 (no key needed).
 *  2. CurseForge reverse lookup by fingerprint (needs the stored API key;
 *     skipped quietly without one).
 *  3. The jar's own manifest (jar-metadata-reader.ts).
 *
 * A jar nothing recognizes comes back with source `unknown` and its filename
 * as the name. A registry that's down, rate-limited or rejects the key is
 * logged and skipped, never thrown: identification is best effort, and the
 * later layers still run.
 */
@Injectable()
export class JarIdentifierService {
  private readonly logger = new Logger(JarIdentifierService.name);

  constructor(
    private readonly modrinth: ModrinthApiService,
    private readonly curseforge: CurseforgeApiService,
  ) {}

  async identify(jar: JarInput): Promise<IdentifiedJar> {
    const [result] = await this.identifyMany([jar]);
    return result!;
  }

  /**
   * Identify several jars with one batched request per registry (plus one
   * for project details), not one per jar. Results are in input order.
   */
  async identifyMany(jars: JarInput[]): Promise<IdentifiedJar[]> {
    const results = jars.map(unidentified);
    const pending = () => results.filter((r) => r.source === 'unknown');

    await this.matchModrinth(results);
    await this.matchCurseforge(pending());
    await Promise.all(
      results.map(async (r, i) => {
        if (r.source === 'unknown') await this.matchMetadata(r, jars[i]!.data);
      }),
    );
    return results;
  }

  private async matchModrinth(results: IdentifiedJar[]): Promise<void> {
    if (!results.length) return;
    let byHash: Map<string, ModrinthVersionWithProject>;
    try {
      byHash = await this.modrinth.getVersionsByHashes(
        results.map((r) => r.sha1),
      );
    } catch (err) {
      this.logger.warn(`Modrinth hash lookup failed: ${String(err)}`);
      return;
    }
    if (!byHash.size) return;
    // Titles and icons are a nicety; a failure here keeps the matches.
    const projects = await this.modrinth
      .getProjects([...byHash.values()].map((v) => v.project_id))
      .catch((err: unknown) => {
        this.logger.warn(`Modrinth project lookup failed: ${String(err)}`);
        return new Map<string, ModrinthProject>();
      });

    for (const r of results) {
      const v = byHash.get(r.sha1);
      if (!v) continue;
      const p = projects.get(v.project_id);
      const loaders = (v.loaders ?? []).map((l) => l.toLowerCase());
      Object.assign(r, {
        source: 'modrinth',
        platform: 'modrinth',
        projectId: v.project_id,
        versionId: v.id,
        slug: p?.slug ?? v.project_id,
        name: p?.title ?? v.name ?? r.name,
        version: v.version_number,
        iconUrl: p?.icon_url ?? null,
        loaders,
        mcVersions: v.game_versions,
        kind: kindFromLoaders(loaders),
      } satisfies Partial<IdentifiedJar>);
    }
  }

  private async matchCurseforge(results: IdentifiedJar[]): Promise<void> {
    if (!results.length) return;
    let matches: CurseforgeFingerprintMatch[];
    try {
      matches = await this.curseforge.getFingerprintMatches(
        results.map((r) => r.fingerprint),
      );
    } catch (err) {
      // No key stored: an expected setup, not worth a warning per import.
      if (err instanceof PreconditionFailedException)
        this.logger.debug('No CurseForge API key; skipping fingerprint lookup');
      else
        this.logger.warn(
          `CurseForge fingerprint lookup failed: ${String(err)}`,
        );
      return;
    }
    if (!matches.length) return;
    const byPrint = new Map(matches.map((m) => [m.fingerprint, m]));
    const mods = await this.curseforge
      .getMods(matches.map((m) => m.modId))
      .catch((err: unknown) => {
        this.logger.warn(`CurseForge project lookup failed: ${String(err)}`);
        return new Map<number, CurseforgeMod>();
      });

    for (const r of results) {
      const match = byPrint.get(r.fingerprint);
      if (!match) continue;
      const mod = mods.get(match.modId);
      const { mcVersions, loaders } = splitCurseforgeGameVersions(
        match.file.gameVersions,
      );
      Object.assign(r, {
        source: 'curseforge',
        platform: 'curseforge',
        projectId: String(match.modId),
        versionId: String(match.file.fileId),
        slug: mod?.slug ?? String(match.modId),
        name: mod?.name ?? match.file.name,
        version: match.file.name,
        iconUrl: mod?.iconUrl ?? null,
        loaders,
        mcVersions,
        kind: mod
          ? mod.classId === CF_CLASS_PLUGINS
            ? 'plugin'
            : 'mod'
          : kindFromLoaders(loaders),
      } satisfies Partial<IdentifiedJar>);
    }
  }

  private async matchMetadata(r: IdentifiedJar, data: Buffer): Promise<void> {
    const meta = await readJarMetadata(data);
    if (!meta) return;
    Object.assign(r, {
      source: 'metadata',
      name: meta.name ?? r.name,
      version: meta.version,
      loaders: meta.loaders,
      mcConstraint: meta.mcConstraint,
      kind: meta.kind,
    } satisfies Partial<IdentifiedJar>);
  }
}
