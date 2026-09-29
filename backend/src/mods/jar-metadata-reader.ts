// Last layer of JarIdentifierService's chain: what a jar says about itself.
// Reads the loader manifests a mod/plugin jar ships at a fixed path and pulls
// out a best-effort id / name / version / Minecraft requirement, for jars that
// neither Modrinth nor CurseForge recognizes (private builds, custom forks,
// registries we don't query).
//
// Plain functions, no DI (same as items/item-zip-parser.ts, whose yauzl walk
// this reuses rather than adding a second zip reader). Nothing is written to
// disk and entries are matched by exact name against a fixed list, so the
// zip-slip rules in utils/safe-zip-extractor.ts don't come into it; the walk
// caps each entry it reads at 16MB.
import * as yaml from 'js-yaml';
import { parse as parseToml } from 'smol-toml';
import { pickZipEntries } from '../items/item-zip-parser';
import type { JarManifestLoader, JarMetadata } from './mods.types';

type ParsedManifest = Omit<JarMetadata, 'manifest' | 'loaders'>;

interface ManifestFormat {
  entry: string;
  loader: JarManifestLoader;
  parse: (text: string, entries: Map<string, string>) => ParsedManifest | null;
}

const MANIFEST_MF = 'META-INF/MANIFEST.MF';

/** A usable manifest string: non-empty and not an unexpanded `${...}` build placeholder. */
function str(v: unknown): string | null {
  if (typeof v === 'number') return String(v);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && !s.includes('${') ? s : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The first object in `list` whose `key` is `value` (dependency lists). */
function findEntry(
  list: unknown,
  key: string,
  value: string,
): Record<string, unknown> | null {
  if (!Array.isArray(list)) return null;
  for (const item of list as unknown[])
    if (isRecord(item) && item[key] === value) return item;
  return null;
}

/** A version requirement written as a string or a list of alternatives. */
function constraint(v: unknown): string | null {
  if (Array.isArray(v)) {
    const parts = v.map(str).filter((s): s is string => s !== null);
    return parts.length ? parts.join(' || ') : null;
  }
  return str(v);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** `Implementation-Version` from META-INF/MANIFEST.MF, the usual stand-in for `${file.jarVersion}`. */
function manifestMfVersion(entries: Map<string, string>): string | null {
  const m = /^Implementation-Version:[ \t]*(.+)$/m.exec(
    entries.get(MANIFEST_MF) ?? '',
  );
  return m ? str(m[1]) : null;
}

function parseFabric(text: string): ParsedManifest | null {
  const j = parseJson(text);
  if (!isRecord(j)) return null;
  const depends = isRecord(j.depends) ? j.depends : {};
  return {
    kind: 'mod',
    modId: str(j.id),
    name: str(j.name) ?? str(j.id),
    version: str(j.version),
    mcConstraint: constraint(depends.minecraft),
  };
}

function parseQuilt(text: string): ParsedManifest | null {
  const j = parseJson(text);
  if (!isRecord(j) || !isRecord(j.quilt_loader)) return null;
  const ql = j.quilt_loader;
  const meta = isRecord(ql.metadata) ? ql.metadata : {};
  // depends: [ "id" | { id, versions } ]
  const mc = findEntry(ql.depends, 'id', 'minecraft');
  return {
    kind: 'mod',
    modId: str(ql.id),
    name: str(meta.name) ?? str(ql.id),
    version: str(ql.version),
    mcConstraint: mc ? constraint(mc.versions) : null,
  };
}

/** META-INF/mods.toml (Forge) and META-INF/neoforge.mods.toml share a format. */
function parseModsToml(
  text: string,
  entries: Map<string, string>,
): ParsedManifest | null {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text);
  } catch {
    return null;
  }
  const mod = Array.isArray(doc.mods) ? (doc.mods[0] as unknown) : null;
  if (!isRecord(mod)) return null;
  const modId = str(mod.modId);
  // [[dependencies.<modId>]] modId = "minecraft", versionRange = "[1.20.1,1.21)"
  const deps =
    isRecord(doc.dependencies) && modId ? doc.dependencies[modId] : null;
  const mc = findEntry(deps, 'modId', 'minecraft');
  return {
    kind: 'mod',
    modId,
    name: str(mod.displayName) ?? modId,
    version: str(mod.version) ?? manifestMfVersion(entries),
    mcConstraint: mc ? str(mc.versionRange) : null,
  };
}

/** Legacy Forge (1.12 and older): a JSON list, or `{ modList: [...] }` in format 2. */
function parseMcmodInfo(text: string): ParsedManifest | null {
  const j = parseJson(text);
  const list = Array.isArray(j)
    ? j
    : isRecord(j) && Array.isArray(j.modList)
      ? j.modList
      : [];
  const mod: unknown = list[0];
  if (!isRecord(mod)) return null;
  return {
    kind: 'mod',
    modId: str(mod.modid),
    name: str(mod.name) ?? str(mod.modid),
    version: str(mod.version),
    mcConstraint: str(mod.mcversion),
  };
}

/** plugin.yml (Bukkit/Spigot/Paper) and paper-plugin.yml share these keys. */
function parsePluginYml(text: string): ParsedManifest | null {
  let y: unknown;
  try {
    // FAILSAFE keeps every scalar a string: the default schema would read
    // `version: 1.10` or `api-version: 1.20` as the number 1.1 / 1.2.
    y = yaml.load(text, { schema: yaml.FAILSAFE_SCHEMA });
  } catch {
    return null;
  }
  if (!isRecord(y)) return null;
  return {
    kind: 'plugin',
    modId: str(y.name),
    name: str(y.name),
    version: str(y.version),
    mcConstraint: str(y['api-version']),
  };
}

// Priority order: when a jar ships several manifests (multi-loader builds),
// the first one that parses supplies the fields.
const FORMATS: ManifestFormat[] = [
  { entry: 'fabric.mod.json', loader: 'fabric', parse: parseFabric },
  { entry: 'quilt.mod.json', loader: 'quilt', parse: parseQuilt },
  {
    entry: 'META-INF/neoforge.mods.toml',
    loader: 'neoforge',
    parse: parseModsToml,
  },
  { entry: 'META-INF/mods.toml', loader: 'forge', parse: parseModsToml },
  { entry: 'mcmod.info', loader: 'forge', parse: parseMcmodInfo },
  { entry: 'paper-plugin.yml', loader: 'paper', parse: parsePluginYml },
  { entry: 'plugin.yml', loader: 'bukkit', parse: parsePluginYml },
];

const WANTED = new Set([...FORMATS.map((f) => f.entry), MANIFEST_MF]);

/** Pick metadata out of already-read manifest texts (entry name -> text). */
export function metadataFromEntries(
  entries: Map<string, string>,
): JarMetadata | null {
  const present = FORMATS.filter((f) => entries.has(f.entry));
  for (const format of present) {
    const parsed = format.parse(entries.get(format.entry)!, entries);
    if (!parsed) continue;
    const loaders = [
      ...new Set([format.loader, ...present.map((f) => f.loader)]),
    ];
    return { manifest: format.entry, loaders, ...parsed };
  }
  return null;
}

/**
 * Read a jar's own manifest. Returns null when the jar isn't a readable zip
 * or has no manifest this recognizes; never throws.
 */
export async function readJarMetadata(
  jar: Buffer | string,
): Promise<JarMetadata | null> {
  let raw: Map<string, Buffer>;
  try {
    raw = await pickZipEntries(jar, (name) => WANTED.has(name));
  } catch {
    return null;
  }
  const entries = new Map<string, string>();
  // Strip a UTF-8 BOM: some manifests have one, and JSON.parse rejects it.
  for (const [name, buf] of raw)
    entries.set(name, buf.toString('utf8').replace(/^\uFEFF/, ''));
  return metadataFromEntries(entries);
}
