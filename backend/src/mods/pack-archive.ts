import { BadRequestException } from '@nestjs/common';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import type { ExpectedHash } from './mods.types';

// Pure parsing / layout detection for the Mods-tab zip import. Everything
// here works on an archive that safe-zip-extractor.ts has already extracted
// into a scratch directory; nothing here writes anywhere. See MODS_NOTES.md,
// "Zip / .mrpack import".

/** A pack pinning more files than this is malformed, not a real modpack. */
export const MAX_INDEX_FILES = 1000;
/** A jar zip with more jars than this is not a mod collection. */
export const MAX_ARCHIVE_JARS = 500;

export const MRPACK_INDEX = 'modrinth.index.json';

/**
 * Override trees in apply order. `server-overrides/` goes second so its copy
 * of a path wins over `overrides/`. `client-overrides/` is never applied to a
 * server. A plain jar zip only has `overrides/`.
 */
export const MRPACK_OVERRIDE_ROOTS = ['overrides', 'server-overrides'] as const;
export const ZIP_OVERRIDE_ROOTS = ['overrides'] as const;

/** Where a server keeps an import's backups of files its overrides replaced. */
export const IMPORT_BACKUP_DIR = '.import-backups';

const MRPACK_LOADER_KEYS: Record<string, string> = {
  'fabric-loader': 'fabric',
  'quilt-loader': 'quilt',
  forge: 'forge',
  neoforge: 'neoforge',
};

export type ServerEnvSupport = 'required' | 'optional' | 'unsupported';

export interface MrpackFile {
  /** `/`-separated destination inside the instance, e.g. `mods/sodium.jar`. */
  path: string;
  /** Download URLs in the index's order; later ones are fallbacks. */
  downloads: string[];
  /** sha512 when the index has it (the spec requires both), else sha1. */
  expectedHash: ExpectedHash;
  sha1: string | null;
  serverEnv: ServerEnvSupport;
}

export interface MrpackIndex {
  name: string;
  version: string | null;
  mcVersion: string | null;
  loader: string | null;
  loaderVersion: string | null;
  files: MrpackFile[];
  /** Index entries dropped as unusable (no path, no downloads, no hash). */
  invalidFiles: number;
}

const hex = (len: number) =>
  z.string().regex(new RegExp(`^[0-9a-fA-F]{${len}}$`));

const indexFileSchema = z.object({
  path: z.string().min(1).max(500),
  hashes: z
    .object({ sha1: hex(40).optional(), sha512: hex(128).optional() })
    .refine((h) => Boolean(h.sha1 || h.sha512), 'no sha1/sha512'),
  downloads: z.array(z.string().min(1).max(2000)).min(1).max(10),
  env: z
    .object({ server: z.enum(['required', 'optional', 'unsupported']) })
    .partial()
    .optional(),
});

const indexSchema = z.object({
  game: z.literal('minecraft'),
  name: z.string().max(500).optional(),
  versionId: z.string().max(200).optional(),
  files: z.array(z.unknown()),
  dependencies: z.record(z.string(), z.string()).optional(),
});

/** Parse a `modrinth.index.json`. Throws 400 for anything that isn't one. */
export function parseMrpackIndex(text: string): MrpackIndex {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BadRequestException(`${MRPACK_INDEX} is not valid JSON`);
  }
  const parsed = indexSchema.safeParse(raw);
  if (!parsed.success)
    throw new BadRequestException(
      `${MRPACK_INDEX} is not a Minecraft Modrinth modpack index`,
    );
  const index = parsed.data;
  if (index.files.length > MAX_INDEX_FILES)
    throw new BadRequestException(
      `The pack lists ${index.files.length} files; the limit is ${MAX_INDEX_FILES}`,
    );

  const files: MrpackFile[] = [];
  let invalidFiles = 0;
  for (const entry of index.files) {
    const f = indexFileSchema.safeParse(entry);
    if (!f.success) {
      invalidFiles += 1;
      continue;
    }
    const { sha1, sha512 } = f.data.hashes;
    files.push({
      path: f.data.path,
      downloads: f.data.downloads,
      expectedHash: sha512
        ? { algorithm: 'sha512', hex: sha512.toLowerCase() }
        : { algorithm: 'sha1', hex: sha1!.toLowerCase() },
      sha1: sha1?.toLowerCase() ?? null,
      serverEnv: f.data.env?.server ?? 'required',
    });
  }

  const deps = index.dependencies ?? {};
  const loaderKey = Object.keys(MRPACK_LOADER_KEYS).find((k) => deps[k]);
  return {
    name: (index.name || 'Modrinth modpack').slice(0, 120),
    version: index.versionId ? index.versionId.slice(0, 60) : null,
    mcVersion: deps.minecraft ? deps.minecraft.slice(0, 32) : null,
    loader: loaderKey ? MRPACK_LOADER_KEYS[loaderKey]! : null,
    loaderVersion: loaderKey ? deps[loaderKey]!.slice(0, 60) : null,
    files,
    invalidFiles,
  };
}

/**
 * The bare jar filename a pack path installs as, or null when the path isn't
 * a jar directly inside `mods/` or `plugins/`. Only the basename is ever used
 * as a filename; the rest of the path never reaches a filesystem call.
 */
export function contentJarName(packPath: string): string | null {
  const m = /^(?:mods|plugins)\/([^/\\\0]+\.jar)$/i.exec(packPath);
  if (!m) return null;
  const name = m[1]!;
  return name === '.' || name === '..' || name.startsWith('.') ? null : name;
}

/** A jar sitting inside the extracted archive. */
export interface StagedJar {
  /** `/`-separated path inside the archive. */
  path: string;
  /** Absolute path of the extracted copy in the staging directory. */
  abs: string;
  filename: string;
}

export interface StagedPack {
  format: 'mrpack' | 'jars';
  index: MrpackIndex | null;
  /** Jars bundled in the archive. For a .mrpack, only `<override root>/mods|plugins/*.jar`. */
  jars: StagedJar[];
  /** Override roots present in the archive, in apply order. */
  overrideRoots: string[];
}

/** Every regular file under `dir`, as `/`-separated paths relative to it. Symlinks are skipped. */
export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(child);
      else if (e.isFile()) out.push(child);
    }
  };
  await walk('');
  return out.sort();
}

const isJunk = (rel: string) =>
  rel.startsWith('__MACOSX/') ||
  rel.split('/').some((seg) => seg.startsWith('.'));

/**
 * The jar in an override tree that is really content: `<root>/mods/x.jar` or
 * `<root>/plugins/x.jar`. Those are installed and tracked like any other jar
 * rather than copied in as anonymous override files.
 */
export function overrideJarName(
  rel: string,
  roots: readonly string[],
): string | null {
  for (const root of roots) {
    if (rel.startsWith(`${root}/`))
      return contentJarName(rel.slice(root.length + 1));
  }
  return null;
}

/**
 * Work out what an extracted archive is:
 *  - `mrpack`: `modrinth.index.json` at the root. Jars come from the index
 *    (downloaded) plus any in an override tree's mods/ or plugins/.
 *  - `jars`: anything else with at least one jar or an `overrides/` tree.
 *    Every jar outside `overrides/` counts, at any depth; `__MACOSX/` and
 *    dot-files are ignored.
 */
export async function describeStagedPack(
  stagingDir: string,
): Promise<StagedPack> {
  const files = await listFiles(stagingDir);
  const present = new Set(files);

  if (present.has(MRPACK_INDEX)) {
    const index = parseMrpackIndex(
      await fsp.readFile(path.join(stagingDir, MRPACK_INDEX), 'utf8'),
    );
    const roots = MRPACK_OVERRIDE_ROOTS.filter((r) =>
      files.some((f) => f.startsWith(`${r}/`)),
    );
    const jars = files
      .filter((f) => !isJunk(f))
      .flatMap((f) => {
        const filename = overrideJarName(f, roots);
        return filename
          ? [{ path: f, abs: path.join(stagingDir, f), filename }]
          : [];
      });
    if (jars.length > MAX_ARCHIVE_JARS)
      throw new BadRequestException(
        `The pack bundles ${jars.length} jars; the limit is ${MAX_ARCHIVE_JARS}`,
      );
    return { format: 'mrpack', index, jars, overrideRoots: roots };
  }

  const roots = ZIP_OVERRIDE_ROOTS.filter((r) =>
    files.some((f) => f.startsWith(`${r}/`)),
  );
  const jars: StagedJar[] = [];
  for (const f of files) {
    if (isJunk(f) || !/\.jar$/i.test(f)) continue;
    if (roots.some((r) => f.startsWith(`${r}/`))) {
      const filename = overrideJarName(f, roots);
      if (filename)
        jars.push({ path: f, abs: path.join(stagingDir, f), filename });
      continue;
    }
    jars.push({
      path: f,
      abs: path.join(stagingDir, f),
      filename: path.posix.basename(f),
    });
  }
  if (!jars.length && !roots.length)
    throw new BadRequestException(
      `Unrecognized archive: not a Modrinth modpack (${MRPACK_INDEX}) and no mod or plugin jars inside`,
    );
  if (jars.length > MAX_ARCHIVE_JARS)
    throw new BadRequestException(
      `The archive has ${jars.length} jars; the limit is ${MAX_ARCHIVE_JARS}`,
    );
  return { format: 'jars', index: null, jars, overrideRoots: roots };
}
