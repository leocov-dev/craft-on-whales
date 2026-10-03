// Minimal Anvil region (.mca) reader/repacker: just enough to find chunks that
// almost nobody has visited (low InhabitedTime) and rewrite the file without
// them. The format has been stable since 2012:
//
//   bytes 0..4095      1024 location entries, 4 bytes each:
//                      3-byte big-endian sector offset + 1-byte sector count.
//                      offset 0 (and count 0) => chunk not present.
//   bytes 4096..8191   1024 timestamp entries, 4 bytes each.
//   from byte 8192     4 KiB sectors. A chunk payload is:
//                      4-byte big-endian length, 1-byte compression type,
//                      then (length - 1) bytes of compressed chunk NBT.
//                      type 1 = gzip, 2 = zlib, 3 = none; the 0x80 bit means
//                      the payload lives in an external .mcc file.
//
// InhabitedTime is a top-level Long on 1.18+ worlds and Level.InhabitedTime on
// older ones. Modelled on upstream's `src/utils/mcaRegion.js`.

import * as zlib from 'node:zlib';
import { promisify } from 'node:util';
import * as nbt from 'prismarine-nbt';

export const SECTOR = 4096;
const ENTRIES = 1024;

/**
 * Cap on one chunk's decompressed size. A real chunk NBT is far below this, but
 * a crafted region could declare a tiny payload that inflates to a huge buffer;
 * zlib enforces this ceiling before allocating.
 */
const MAX_CHUNK_OUTPUT_BYTES = 64 * 1024 * 1024;

const inflateAsync = promisify(zlib.inflate);
const gunzipAsync = promisify(zlib.gunzip);

export interface RegionEntry {
  /** 0..1023 header slot. */
  index: number;
  /** Chunk coordinates within the region (0..31). */
  x: number;
  z: number;
  sectorOffset: number;
  sectorCount: number;
  timestamp: number;
  /** Payload lives in a `.mcc` sidecar; never dropped. */
  external: boolean;
  /** The entry's sectors run past the end of the file. */
  truncated: boolean;
}

async function inflateChunk(
  payload: Buffer,
  compressionType: number,
): Promise<Buffer> {
  const type = compressionType & 0x7f;
  const opts = { maxOutputLength: MAX_CHUNK_OUTPUT_BYTES };
  if (type === 1) return gunzipAsync(payload, opts);
  if (type === 2) return inflateAsync(payload, opts);
  if (type === 3) return payload;
  throw new Error(`unknown chunk compression type ${compressionType}`);
}

/** prismarine-nbt `simplify()` hands a Long back as `[high, low]` int32 words. */
function longToNumber(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (Array.isArray(v) && v.length === 2) {
    const [high, low] = v as [number, number];
    return (high >>> 0) * 4294967296 + (low >>> 0);
  }
  return null;
}

function readInhabitedTime(simplified: unknown): number | null {
  if (!simplified || typeof simplified !== 'object') return null;
  const root = simplified as {
    InhabitedTime?: unknown;
    Level?: { InhabitedTime?: unknown };
  };
  const v = root.InhabitedTime ?? root.Level?.InhabitedTime;
  return v == null ? null : longToNumber(v);
}

/** Parse the 8 KiB header; one entry per present chunk. */
export function parseHeader(buf: Buffer): RegionEntry[] {
  if (buf.length < SECTOR * 2) return [];
  const out: RegionEntry[] = [];
  for (let i = 0; i < ENTRIES; i++) {
    const loc = buf.readUInt32BE(i * 4);
    const sectorOffset = loc >>> 8;
    const sectorCount = loc & 0xff;
    if (sectorOffset === 0 || sectorCount === 0) continue;
    const payloadStart = sectorOffset * SECTOR;
    const external =
      payloadStart + 5 <= buf.length &&
      Boolean(buf.readUInt8(payloadStart + 4) & 0x80);
    out.push({
      index: i,
      x: i % 32,
      z: Math.floor(i / 32),
      sectorOffset,
      sectorCount,
      timestamp: buf.readUInt32BE(SECTOR + i * 4),
      external,
      truncated: (sectorOffset + sectorCount) * SECTOR > buf.length,
    });
  }
  return out;
}

/**
 * Decompress + decode one chunk and return its InhabitedTime in ticks, or null
 * when it can't be read (callers treat that as "keep").
 */
export async function chunkInhabitedTime(
  buf: Buffer,
  entry: RegionEntry,
): Promise<number | null> {
  if (entry.external || entry.truncated) return null;
  const start = entry.sectorOffset * SECTOR;
  if (start + 5 > buf.length) return null;
  const length = buf.readUInt32BE(start);
  if (length <= 1 || start + 4 + length > buf.length) return null;
  const compType = buf.readUInt8(start + 4);
  const payload = buf.subarray(start + 5, start + 4 + length);
  try {
    const raw = await inflateChunk(payload, compType);
    const { parsed } = await nbt.parse(raw);
    return readInhabitedTime(nbt.simplify(parsed));
  } catch {
    return null;
  }
}

export interface RepackResult {
  buffer: Buffer;
  kept: number;
  dropped: number;
}

/**
 * Rebuild a region buffer keeping only the header slots for which `keep(index)`
 * is true, repacking their sectors contiguously so the file actually shrinks.
 * Returns null when nothing would be dropped. Throws if a slot that would be
 * kept runs past the end of the file: copying it would silently corrupt it, so
 * the caller must leave that file alone.
 */
export function repack(
  buf: Buffer,
  keep: (index: number) => boolean,
): RepackResult | null {
  const entries = parseHeader(buf);
  const keptEntries = entries.filter((e) => keep(e.index));
  if (keptEntries.length === entries.length) return null;
  if (keptEntries.some((e) => e.truncated)) {
    throw new Error('region file is truncated; refusing to repack it');
  }

  const header = Buffer.alloc(SECTOR * 2);
  const sectors: Buffer[] = [];
  let nextSector = 2; // sectors 0 and 1 are the header

  for (const e of keptEntries) {
    sectors.push(
      buf.subarray(
        e.sectorOffset * SECTOR,
        (e.sectorOffset + e.sectorCount) * SECTOR,
      ),
    );
    header.writeUInt32BE(
      ((nextSector << 8) | (e.sectorCount & 0xff)) >>> 0,
      e.index * 4,
    );
    header.writeUInt32BE(e.timestamp >>> 0, SECTOR + e.index * 4);
    nextSector += e.sectorCount;
  }

  return {
    buffer: Buffer.concat([header, ...sectors]),
    kept: keptEntries.length,
    dropped: entries.length - keptEntries.length,
  };
}
