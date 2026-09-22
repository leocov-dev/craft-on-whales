// Hand-rolled STORE-method zip writer, test-only (excluded from the build —
// see tsconfig.build.json). No zip-writer with symlink/backslash-entry
// support is in the dependency tree (archiver only ever writes real files),
// and these are exactly the malformed/hostile shapes safe-zip-extractor.ts
// needs to reject, so the fixtures are built by hand at the byte level
// instead.
import * as zlib from 'node:zlib';

export interface ZipFixtureEntry {
  name: string;
  content?: Buffer | string;
  /** Unix external file attributes' mode bits (e.g. 0o120777 for a symlink). Omit for an ordinary DOS-authored entry (no unix mode bits at all). */
  unixMode?: number;
}

/** Build a minimal, valid (STORE/no-compression) zip file from raw entries — including ones no real zip tool would produce, for testing the extractor's guards. */
export function buildZipFixture(entries: ZipFixtureEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const content = Buffer.isBuffer(e.content)
      ? e.content
      : Buffer.from(e.content ?? '', 'utf8');
    const crc = e.name.endsWith('/') ? 0 : zlib.crc32(content) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18); // compressed size
    local.writeUInt32LE(content.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    const localRecord = Buffer.concat([local, nameBuf, content]);
    localParts.push(localRecord);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    // version made by: high byte 3 = UNIX when unixMode given, else 0 (DOS/FAT — no mode bits)
    central.writeUInt16LE(e.unixMode !== undefined ? (3 << 8) | 20 : 20, 4);
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method
    central.writeUInt16LE(0, 12); // mod time
    central.writeUInt16LE(0, 14); // mod date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(((e.unixMode ?? 0) << 16) >>> 0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(Buffer.concat([central, nameBuf]));

    offset += localRecord.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const localDir = Buffer.concat(localParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(localDir.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localDir, centralDir, eocd]);
}

// S_IFLNK — unix symlink file-type bits, permissions 0777.
export const UNIX_MODE_SYMLINK = 0o120777;
// S_IFREG — unix regular-file bits, permissions 0644 (used to exercise the
// "unix mode present, but ordinary" pass-through path).
export const UNIX_MODE_REGULAR_FILE = 0o100644;
