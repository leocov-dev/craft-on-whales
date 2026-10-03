import * as zlib from 'node:zlib';
import { SECTOR, chunkInhabitedTime, parseHeader, repack } from './mca-region';
import { buildRegion, chunkPayload } from './mca-region.test-helpers';

describe('mca-region', () => {
  it('reads InhabitedTime from 1.18+ and legacy chunk layouts', async () => {
    const region = buildRegion({
      0: chunkPayload(5000),
      1: chunkPayload(7, { legacy: true }),
      2: chunkPayload(6_000_000_000), // beyond int32: exercises the [high, low] words
    });
    const entries = parseHeader(region);
    const ticks = await Promise.all(
      entries.map((e) => chunkInhabitedTime(region, e)),
    );
    expect(ticks).toEqual([5000, 7, 6_000_000_000]);
  });

  it('reports slot coordinates and timestamps', () => {
    const region = buildRegion({ 33: chunkPayload(1) });
    expect(parseHeader(region)).toEqual([
      expect.objectContaining({
        index: 33,
        x: 1,
        z: 1,
        timestamp: 1_700_000_033,
        external: false,
        truncated: false,
      }),
    ]);
  });

  it('returns null for payloads it cannot read', async () => {
    const lz4 = Buffer.from(chunkPayload(1));
    lz4.writeUInt8(4, 4); // LZ4: unsupported
    const bomb = Buffer.alloc(5 + 20);
    bomb.writeUInt32BE(21, 0);
    bomb.writeUInt8(2, 4);
    zlib.deflateSync(Buffer.from('not nbt')).copy(bomb, 5);
    const external = Buffer.from(chunkPayload(1));
    external.writeUInt8(2 | 0x80, 4);
    const region = buildRegion({ 0: lz4, 1: bomb, 2: external });
    const entries = parseHeader(region);
    expect(entries[2]?.external).toBe(true);
    for (const e of entries) {
      expect(await chunkInhabitedTime(region, e)).toBeNull();
    }
  });

  describe('repack', () => {
    it('drops slots, compacts sectors, and keeps the survivors intact', async () => {
      const region = buildRegion({
        0: chunkPayload(10),
        1: chunkPayload(9000),
        2: chunkPayload(20),
        3: chunkPayload(9500),
      });
      const result = repack(region, (i) => i === 1 || i === 3);
      expect(result).not.toBeNull();
      expect(result).toMatchObject({ kept: 2, dropped: 2 });
      expect(result!.buffer.length).toBeLessThan(region.length);
      expect(result!.buffer.length % SECTOR).toBe(0);

      const entries = parseHeader(result!.buffer);
      expect(entries.map((e) => e.index)).toEqual([1, 3]);
      expect(entries.map((e) => e.timestamp)).toEqual([
        1_700_000_001, 1_700_000_003,
      ]);
      expect(
        await Promise.all(
          entries.map((e) => chunkInhabitedTime(result!.buffer, e)),
        ),
      ).toEqual([9000, 9500]);
      // Sectors are contiguous right after the header.
      expect(entries[0]!.sectorOffset).toBe(2);
    });

    it('returns null when nothing would be dropped', () => {
      const region = buildRegion({ 0: chunkPayload(1) });
      expect(repack(region, () => true)).toBeNull();
    });

    it('yields an empty (header-only) buffer when every slot is dropped', () => {
      const region = buildRegion({ 0: chunkPayload(1) });
      const result = repack(region, () => false);
      expect(result).toMatchObject({ kept: 0, dropped: 1 });
      expect(result!.buffer.length).toBe(SECTOR * 2);
    });

    it('refuses to copy a kept slot that runs past the end of the file', () => {
      const region = buildRegion({ 0: chunkPayload(1), 1: chunkPayload(2) });
      const cut = region.subarray(0, region.length - SECTOR);
      expect(parseHeader(cut).some((e) => e.truncated)).toBe(true);
      expect(() => repack(cut, (i) => i === 1)).toThrow(/truncated/);
      // A truncated slot that is being dropped is fine.
      expect(repack(cut, (i) => i === 0)).not.toBeNull();
    });
  });
});
