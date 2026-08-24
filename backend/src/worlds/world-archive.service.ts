import {
  BadRequestException,
  Injectable,
  PayloadTooLargeException,
} from '@nestjs/common';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as zlib from 'node:zlib';
// @types/archiver has no factory-function signature (only the Archiver
// class) — matching the legacy code's own untyped require() for this
// package rather than fighting the types for a call it genuinely supports.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const archiver = require('archiver');
import yauzl = require('yauzl');
import * as tar from 'tar';

export const DIM_SUFFIXES = ['_nether', '_the_end'];

export interface DetectedWorldRoot {
  rootAbs: string;
  split: boolean;
  dims: string[];
}

// Hard ceiling on total uncompressed extraction size / entry count. Guards
// against a small archive that inflates to hundreds of GB and fills the disk.
const MAX_EXTRACT_BYTES = 50 * 1024 ** 3;
const MAX_EXTRACT_ENTRIES = 200000;

/**
 * Pure archive/filesystem plumbing for world management — zip/unzip, world
 * root detection, level.dat NBT scans, small path/name utilities. No DB, no
 * ServersModule dependency; every method takes absolute paths as params.
 * Ports the bottom half of `src/services/worlds.ts`.
 */
@Injectable()
export class WorldArchiveService {
  /**
   * Find the world root inside an extracted archive: the shallowest
   * directory containing a level.dat (handles nested single-folder wrappers
   * and level.dat anywhere in the tree). Detects Bukkit-split layouts
   * (sibling <name>_nether / <name>_the_end directories next to the main
   * world). dims[0] is always the main root; extras are split dimension dirs.
   */
  async detectWorldRoot(
    extractedDir: string,
  ): Promise<DetectedWorldRoot | null> {
    let queue = [path.resolve(extractedDir)];
    let found: string | null = null;

    while (queue.length && !found) {
      const next: string[] = [];
      const candidates: string[] = [];
      for (const dir of queue) {
        let entries;
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        if (
          entries.some(
            (e) => e.isFile() && e.name.toLowerCase() === 'level.dat',
          )
        ) {
          candidates.push(dir);
          continue;
        }
        for (const e of entries) {
          if (e.isDirectory() && !e.isSymbolicLink())
            next.push(path.join(dir, e.name));
        }
      }
      if (candidates.length) {
        found =
          candidates.find((c) => !this.isDimName(path.basename(c))) ||
          (candidates[0] as string);
      }
      queue = next;
    }
    if (!found) return null;

    const dims = [found];
    let split = false;
    if (found !== path.resolve(extractedDir)) {
      const base = path.basename(found);
      const parent = path.dirname(found);
      for (const suffix of DIM_SUFFIXES) {
        const sibling = path.join(parent, base + suffix);
        try {
          if ((await fsp.stat(sibling)).isDirectory()) {
            dims.push(sibling);
            split = true;
          }
        } catch {
          /* no such sibling */
        }
      }
    }
    return { rootAbs: found, split, dims };
  }

  isDimName(name: string): boolean {
    return DIM_SUFFIXES.some((s) => name.endsWith(s) && name.length > s.length);
  }

  /** 'world_nether' -> 'world', null when not a dim name. */
  dimBase(name: string): string | null {
    for (const suffix of DIM_SUFFIXES) {
      if (name.endsWith(suffix) && name.length > suffix.length)
        return name.slice(0, -suffix.length);
    }
    return null;
  }

  /** Zip a world: root contents at the top level, split dims as sibling dirs. */
  zipWorld(
    outFile: string,
    rootAbs: string,
    dimDirs: string[] = [],
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outFile);
      const archive = archiver('zip', { zlib: { level: 6 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.directory(rootAbs, false);
      for (const dim of dimDirs) archive.directory(dim, path.basename(dim));
      archive.finalize();
    });
  }

  /** Route an archive to the right extractor by magic bytes (zip/.mcworld, tar, tar.gz). */
  async extractArchive(
    file: string,
    destDir: string,
    originalName = '',
  ): Promise<void> {
    const fd = await fsp.open(file, 'r');
    const head = Buffer.alloc(265);
    await fd.read(head, 0, 265, 0);
    await fd.close();

    const isZip = head[0] === 0x50 && head[1] === 0x4b;
    const isGzip = head[0] === 0x1f && head[1] === 0x8b;
    const isTar = head.subarray(257, 262).toString('latin1') === 'ustar';

    if (isZip) return this.extractZip(file, destDir);
    if (isGzip || isTar || /\.tar$/i.test(originalName)) {
      // node-tar sanitizes absolute paths and skips `..` entries by default;
      // the filter also enforces an uncompressed-size ceiling.
      let tarTotal = 0;
      await tar.x({
        file,
        cwd: destDir,
        filter: (p: string, stat: { size?: number }) => {
          if (p.split(/[\\/]/).includes('..')) return false;
          tarTotal += stat?.size || 0;
          if (tarTotal > MAX_EXTRACT_BYTES) {
            throw new PayloadTooLargeException(
              `Archive is too large uncompressed (> ${Math.round(MAX_EXTRACT_BYTES / 1024 ** 3)} GB) — refusing to extract (possible decompression bomb).`,
            );
          }
          return true;
        },
      });
      return;
    }
    throw new BadRequestException(
      `That doesn't look like a zip or tar archive${originalName ? ` (${originalName})` : ''}`,
    );
  }

  /** Zip-slip-safe extraction (yauzl) with a decompression-bomb ceiling. */
  extractZip(zipFile: string, destDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      yauzl.open(zipFile, { lazyEntries: true }, (err, zip) => {
        if (err) return reject(err);
        let settled = false;
        let entryCount = 0;
        let writtenBytes = 0;
        let declaredBytes = 0;
        const fail = (e: Error) => {
          if (settled) return;
          settled = true;
          try {
            zip.destroy?.();
          } catch {
            /* */
          }
          reject(e);
        };
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        zip.on('error', fail);
        zip.on('end', done);
        zip.on('entry', (entry) => {
          if (++entryCount > MAX_EXTRACT_ENTRIES) {
            return fail(
              new PayloadTooLargeException(
                `Archive has too many entries (> ${MAX_EXTRACT_ENTRIES}) — refusing to extract.`,
              ),
            );
          }
          declaredBytes += entry.uncompressedSize || 0;
          if (declaredBytes > MAX_EXTRACT_BYTES) {
            return fail(
              new PayloadTooLargeException(
                `Archive is too large uncompressed (> ${Math.round(MAX_EXTRACT_BYTES / 1024 ** 3)} GB) — refusing to extract (possible decompression bomb).`,
              ),
            );
          }
          const target = path.resolve(destDir, entry.fileName);
          if (
            !target.startsWith(path.resolve(destDir) + path.sep) &&
            target !== path.resolve(destDir)
          ) {
            return fail(
              new BadRequestException(
                `Archive entry escapes destination: ${entry.fileName}`,
              ),
            );
          }
          if (/\/$/.test(entry.fileName)) {
            fs.mkdirSync(target, { recursive: true });
            zip.readEntry();
          } else {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            zip.openReadStream(entry, (streamErr, readStream) => {
              if (streamErr) return fail(streamErr);
              const out = fs.createWriteStream(target);
              readStream.on('data', (chunk: Buffer) => {
                writtenBytes += chunk.length;
                if (writtenBytes > MAX_EXTRACT_BYTES) {
                  readStream.destroy();
                  out.destroy();
                  fail(
                    new PayloadTooLargeException(
                      `Archive exceeds the ${Math.round(MAX_EXTRACT_BYTES / 1024 ** 3)} GB extraction limit — aborted (possible decompression bomb).`,
                    ),
                  );
                }
              });
              out.on('close', () => {
                if (!settled) zip.readEntry();
              });
              out.on('error', fail);
              readStream.pipe(out);
            });
          }
        });
        zip.readEntry();
      });
    });
  }

  /** Read the MC version name ("1.21.5") out of level.dat, or null. */
  readLevelVersion(levelDatAbs: string): string | null {
    const buf = this.readLevelBuffer(levelDatAbs);
    if (!buf) return null;
    // NBT string tag: 0x08, name length (2B BE) = 4, "Name", value length (2B BE), value
    const needle = Buffer.from(
      '080004' + Buffer.from('Name').toString('hex'),
      'hex',
    );
    let idx = buf.indexOf(needle);
    while (idx !== -1) {
      const lenOff = idx + needle.length;
      if (lenOff + 2 <= buf.length) {
        const len = buf.readUInt16BE(lenOff);
        const value = buf
          .subarray(lenOff + 2, lenOff + 2 + len)
          .toString('utf8');
        if (/^\d+\.\d+/.test(value)) return value;
      }
      idx = buf.indexOf(needle, idx + 1);
    }
    return null;
  }

  /** Read the world seed out of level.dat (RandomSeed or WorldGenSettings.seed), or null. */
  readLevelSeed(levelDatAbs: string): string | null {
    const buf = this.readLevelBuffer(levelDatAbs);
    if (!buf) return null;
    for (const name of ['RandomSeed', 'seed']) {
      const needle = Buffer.concat([
        Buffer.from([0x04, 0x00, name.length]),
        Buffer.from(name, 'latin1'),
      ]);
      const idx = buf.indexOf(needle);
      if (idx !== -1 && idx + needle.length + 8 <= buf.length) {
        return buf.readBigInt64BE(idx + needle.length).toString();
      }
    }
    return null;
  }

  private readLevelBuffer(levelDatAbs: string): Buffer | null {
    try {
      const raw: Buffer = fs.readFileSync(levelDatAbs);
      return raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw;
    } catch {
      return null;
    }
  }

  async dirsSize(absDirs: string[]): Promise<number> {
    let total = 0;
    for (const dir of absDirs) total += await this.dirSize(dir);
    return total;
  }

  async dirSize(abs: string): Promise<number> {
    let total = 0;
    let entries;
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const e of entries) {
      const child = path.join(abs, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) total += await this.dirSize(child);
      else if (e.isFile()) {
        try {
          total += (await fsp.stat(child)).size;
        } catch {
          /* transient */
        }
      }
    }
    return total;
  }

  sha256File(abs: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      fs.createReadStream(abs)
        .on('data', (chunk: string | Buffer) => hash.update(chunk))
        .on('end', () => resolve(hash.digest('hex')))
        .on('error', reject);
    });
  }

  /** rename with cross-device fallback (tmp and servers share DATA_DIR, but be safe). */
  async moveFile(from: string, to: string): Promise<void> {
    try {
      await fsp.rename(from, to);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await fsp.copyFile(from, to);
      await fsp.rm(from, { force: true });
    }
  }

  async moveEntry(from: string, to: string): Promise<void> {
    try {
      await fsp.rename(from, to);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await fsp.cp(from, to, { recursive: true });
      await fsp.rm(from, { recursive: true, force: true });
    }
  }

  /** World dir names: strip path separators & control chars, keep it friendly. */
  sanitizeWorldName(name: unknown): string {
    const clean = String(name || '')
      .replace(/[\\/:*?"<>|\0]/g, '_')
      .replace(/^\.+/, '')
      .trim()
      .slice(0, 64);
    if (!clean) throw new BadRequestException('World name cannot be empty');
    return clean;
  }

  /** Reject world names that could traverse paths (route params are user input). */
  checkWorldName(name: unknown): void {
    if (
      !name ||
      /[\\/\0]/.test(String(name)) ||
      name === '.' ||
      name === '..' ||
      String(name).startsWith('.')
    ) {
      throw new BadRequestException('Invalid world name');
    }
  }

  sanitizeFilename(name: unknown): string {
    return String(name)
      .replace(/[\\/:*?"<>|\0]/g, '_')
      .slice(0, 120);
  }

  /** Compare dotted versions: >0 when a is newer than b. Non-numeric parts compare as strings. */
  compareVersions(a: string, b: string): number {
    const pa = String(a).split('.');
    const pb = String(b).split('.');
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const na = Number(pa[i] || 0);
      const nb = Number(pb[i] || 0);
      if (Number.isNaN(na) || Number.isNaN(nb)) {
        const cmp = String(pa[i] || '').localeCompare(String(pb[i] || ''));
        if (cmp !== 0) return cmp;
        continue;
      }
      if (na !== nb) return na - nb;
    }
    return 0;
  }

  humanBytes(n: number): string {
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
    if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(n / 1024))} KB`;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms).unref());
  }
}
