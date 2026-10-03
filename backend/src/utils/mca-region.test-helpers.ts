import * as zlib from 'node:zlib';
import * as nbt from 'prismarine-nbt';
import { SECTOR } from './mca-region';

/** One chunk's NBT with the given InhabitedTime, zlib-compressed as in a real .mca. */
export function chunkPayload(
  inhabitedTicks: number,
  { legacy = false }: { legacy?: boolean } = {},
): Buffer {
  const long = {
    type: 'long' as const,
    value: [Math.floor(inhabitedTicks / 4294967296), inhabitedTicks >>> 0] as [
      number,
      number,
    ],
  };
  const value = legacy
    ? { Level: { type: 'compound' as const, value: { InhabitedTime: long } } }
    : { InhabitedTime: long };
  const raw = nbt.writeUncompressed({
    type: 'compound',
    name: '',
    value,
  });
  const body = zlib.deflateSync(raw);
  const out = Buffer.alloc(5 + body.length);
  out.writeUInt32BE(body.length + 1, 0);
  out.writeUInt8(2, 4); // zlib
  body.copy(out, 5);
  return out;
}

/** Build a region file from `{ slot: payload }`, each payload padded to whole sectors. */
export function buildRegion(chunks: Record<number, Buffer>): Buffer {
  const header = Buffer.alloc(SECTOR * 2);
  const parts: Buffer[] = [];
  let next = 2;
  for (const [slot, payload] of Object.entries(chunks)) {
    const count = Math.ceil(payload.length / SECTOR);
    const padded = Buffer.alloc(count * SECTOR);
    payload.copy(padded);
    header.writeUInt32BE(((next << 8) | count) >>> 0, Number(slot) * 4);
    header.writeUInt32BE(
      1_700_000_000 + Number(slot),
      SECTOR + Number(slot) * 4,
    );
    parts.push(padded);
    next += count;
  }
  return Buffer.concat([header, ...parts]);
}
