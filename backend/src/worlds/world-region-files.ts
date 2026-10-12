import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { repack } from '../utils/mca-region';

export const REGION_RE = /^r\.(-?\d+)\.(-?\d+)\.mca$/;
/** Per-chunk stores that share the region grid (same file names, same slots). */
export const COMPANION_DIRS = ['entities', 'poi'];

export interface RegionFolder {
  /** Absolute path of the `region` directory. */
  regionDir: string;
  /** Label relative to the world folder, for reporting. */
  label: string;
  /** Only the overworld gets spawn protection. */
  isOverworld: boolean;
}

/** A real directory: symlinks are never followed out of the world folder. */
export async function isRealDir(p: string): Promise<boolean> {
  try {
    return (await fsp.lstat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function realSubdirs(p: string): Promise<string[]> {
  try {
    return (await fsp.readdir(p, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Region file names in a `region` folder; empty when it can't be read. */
export async function regionFileNames(regionDir: string): Promise<string[]> {
  try {
    return (await fsp.readdir(regionDir, { withFileTypes: true }))
      .filter((e) => e.isFile() && REGION_RE.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Every `region` folder belonging to a world: the world dir and its
 * Bukkit-style siblings (`world_nether`, `world_the_end`), each of which may
 * hold the region folder directly or under `DIM-1` / `DIM1` /
 * `dimensions/<namespace>/<name>`. `tops` is the main world dir followed by any
 * siblings; `mainIsDim` is true when the main dir is itself a dimension folder.
 */
export async function listRegionFolders(
  tops: string[],
  mainIsDim: boolean,
): Promise<RegionFolder[]> {
  const out: RegionFolder[] = [];
  const seen = new Set<string>();
  const push = async (dir: string, label: string, isOverworld: boolean) => {
    const regionDir = path.join(dir, 'region');
    // lstat only refuses a symlink in the LAST path component, so the
    // dimension folder is checked on its own as well: a symlinked `DIM1`
    // must not lead the repack outside the world.
    if (
      seen.has(regionDir) ||
      !(await isRealDir(dir)) ||
      !(await isRealDir(regionDir))
    )
      return;
    seen.add(regionDir);
    out.push({ regionDir, label, isOverworld });
  };

  for (const [i, top] of tops.entries()) {
    const prefix = i === 0 ? '' : `${path.basename(top)}/`;
    await push(top, i === 0 ? '.' : path.basename(top), i === 0 && !mainIsDim);
    await push(path.join(top, 'DIM-1'), `${prefix}DIM-1`, false);
    await push(path.join(top, 'DIM1'), `${prefix}DIM1`, false);
    const custom = path.join(top, 'dimensions');
    for (const ns of (await isRealDir(custom))
      ? await realSubdirs(custom)
      : []) {
      for (const name of await realSubdirs(path.join(custom, ns))) {
        await push(
          path.join(custom, ns, name),
          `${prefix}dimensions/${ns}/${name}`,
          i === 0 && !mainIsDim && ns === 'minecraft' && name === 'overworld',
        );
      }
    }
  }
  return out;
}

/** Rewrite (or delete) one region-format file keeping only `keep(index)` slots. */
export async function repackRegionFile(
  abs: string,
  keep: (index: number) => boolean,
  dryRun: boolean,
): Promise<{ bytesBefore: number; bytesAfter: number; removed: number }> {
  let buf: Buffer;
  try {
    if (!(await fsp.lstat(abs)).isFile())
      return { bytesBefore: 0, bytesAfter: 0, removed: 0 };
    buf = await fsp.readFile(abs);
  } catch {
    return { bytesBefore: 0, bytesAfter: 0, removed: 0 };
  }
  const packed = repack(buf, keep);
  if (!packed)
    return { bytesBefore: buf.length, bytesAfter: buf.length, removed: 0 };
  const bytesAfter = packed.kept === 0 ? 0 : packed.buffer.length;
  if (!dryRun) {
    if (packed.kept === 0) {
      await fsp.rm(abs, { force: true });
    } else {
      // Temp file + rename: the file is either the old one or the new one,
      // never a partial write, even if the panel dies mid-way.
      const tmp = `${abs}.tmp`;
      try {
        await fsp.writeFile(tmp, packed.buffer);
        await fsp.rename(tmp, abs);
      } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
    }
  }
  return { bytesBefore: buf.length, bytesAfter, removed: packed.dropped };
}
