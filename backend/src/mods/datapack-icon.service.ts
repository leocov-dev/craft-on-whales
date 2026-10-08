import { Injectable } from '@nestjs/common';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type * as yauzl from 'yauzl';
import { openZip, readZipEntry } from '../items/item-zip-parser';
import { PathGuardService } from '../storage/path-guard.service';

const PACK_PNG = 'pack.png';
/** Real pack icons are a few KB (64x64 or 128x128); anything past this is not an icon. */
export const MAX_ICON_BYTES = 512 * 1024;
const MAX_ICON_DIMENSION = 1024;
/** A pack zip with more central-directory entries than this is not scanned for pack.png. */
export const MAX_SCANNED_ENTRIES = 10_000;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const ICON_DIR_REL = 'library/icons/mods';
/** `lib_` keeps the file servable by `GET /api/icons/library/:file`; `dp_` + a `sc_` row id can never equal a library id (`lib_` + 8 chars). */
const OWNED_ICON_RE = /^lib_dp_sc_[\w-]+\.png$/;

/** A PNG within the size caps: signature, an IHDR first chunk, sane dimensions. */
export function isValidPackIcon(buf: Buffer): boolean {
  if (buf.length < 33 || buf.length > MAX_ICON_BYTES) return false;
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  if (buf.readUInt32BE(8) !== 13) return false; // IHDR is always 13 bytes
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return false;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return (
    width > 0 &&
    height > 0 &&
    width <= MAX_ICON_DIMENSION &&
    height <= MAX_ICON_DIMENSION
  );
}

/**
 * `pack.png` of a datapack, stored beside the library's cached icons. Reads are
 * size-capped and validated before anything is written; writes go through
 * PathGuardService and use a name derived from the server_content row id only.
 */
@Injectable()
export class DatapackIconService {
  constructor(private readonly pathGuard: PathGuardService) {}

  /** The pack's `pack.png` bytes when present and a valid PNG; null otherwise. Never throws. */
  async read(abs: string, isDirectory: boolean): Promise<Buffer | null> {
    try {
      const buf = isDirectory
        ? await this.readFromDir(abs)
        : await this.readFromZip(abs);
      return buf && isValidPackIcon(buf) ? buf : null;
    } catch {
      return null;
    }
  }

  private async readFromDir(dir: string): Promise<Buffer | null> {
    const file = path.join(dir, PACK_PNG);
    const st = await fsp.lstat(file);
    // lstat: a symlinked pack.png must not pull in a file from elsewhere.
    if (!st.isFile() || st.size > MAX_ICON_BYTES) return null;
    return fsp.readFile(file);
  }

  private async readFromZip(file: string): Promise<Buffer | null> {
    const zip = await openZip(file);
    return new Promise((resolve) => {
      const done = (buf: Buffer | null) => {
        zip.close();
        resolve(buf);
      };
      zip.on('error', () => done(null));
      zip.on('end', () => done(null));
      let scanned = 0;
      zip.on('entry', (entry: yauzl.Entry) => {
        if (++scanned > MAX_SCANNED_ENTRIES) return done(null);
        if (entry.fileName !== PACK_PNG) return zip.readEntry();
        // The header size is checked first; readZipEntry's cap covers a header that lies.
        if (entry.uncompressedSize > MAX_ICON_BYTES) return done(null);
        readZipEntry(zip, entry, { maxBytes: MAX_ICON_BYTES }).then(done, () =>
          done(null),
        );
      });
      zip.readEntry();
    });
  }

  /** Write the icon for a content row; returns its data-dir-relative path. */
  async store(rowId: string, png: Buffer): Promise<string> {
    const rel = `${ICON_DIR_REL}/lib_dp_${rowId}.png`;
    const abs = this.pathGuard.dataPath(rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, png);
    return rel;
  }

  /** Delete an icon this service wrote; any other path (a library icon) is left alone. */
  async remove(rel: string | null | undefined): Promise<void> {
    if (!rel || path.dirname(rel) !== ICON_DIR_REL) return;
    if (!OWNED_ICON_RE.test(path.basename(rel))) return;
    await fsp.rm(this.pathGuard.dataPath(rel), { force: true });
  }
}
