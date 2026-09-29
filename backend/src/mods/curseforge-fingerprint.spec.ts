import { curseforgeFingerprint, murmur2 } from './curseforge-fingerprint';

describe('murmur2', () => {
  it('passes the SMHasher verification test for 32-bit MurmurHash2', () => {
    // SMHasher's VerificationTest: hash keys {}, {0}, {0,1}, ... {0..254}
    // with seed 256 - length, write each result little-endian into one
    // buffer, then hash that buffer with seed 0. Appleby's published
    // verification value for MurmurHash2 is 0x27864C1E.
    const key = Buffer.alloc(256);
    const hashes = Buffer.alloc(256 * 4);
    for (let i = 0; i < 256; i++) {
      key[i] = i;
      hashes.writeUInt32LE(murmur2(key.subarray(0, i), 256 - i), i * 4);
    }
    expect(murmur2(hashes, 0)).toBe(0x27864c1e);
  });

  it('always returns an unsigned 32-bit integer', () => {
    for (const s of ['', 'a', 'ab', 'abc', 'abcd', 'abcde', '\xff\xff\xff']) {
      const h = murmur2(Buffer.from(s, 'latin1'), 1);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('curseforgeFingerprint', () => {
  // Fixture files from meza/curseforge-fingerprint-go (a port of CurseForge's
  // own C++ fingerprinting code), with the fingerprints its tests expect.
  // Locally checked as well: the same library's two fixture jars
  // (ServerRedstoneBlock-fabric-1.19.3-1.0.0.jar -> 2490932876,
  // fabric-carpet-24w33a-1.4.148+v240818.jar -> 419608402) hash to the
  // expected values; they aren't vendored here to keep binaries out of the repo.
  it('matches known CurseForge fingerprints', () => {
    expect(
      curseforgeFingerprint(Buffer.from('# This is the first test file\n')),
    ).toBe(3608199863);
    expect(
      curseforgeFingerprint(Buffer.from('# This is the second test file\n')),
    ).toBe(3493718775);
  });

  it('drops tab, LF, CR and space before hashing, and nothing else', () => {
    const plain = Buffer.from('hello-world-mod-bytes');
    const spaced = Buffer.from('hel lo-\tworld-\r\nmod- bytes  \n');
    expect(curseforgeFingerprint(spaced)).toBe(curseforgeFingerprint(plain));
    // Hashed with seed 1 over the stripped bytes (and the stripped length).
    expect(curseforgeFingerprint(spaced)).toBe(murmur2(plain, 1));

    // Other whitespace-ish bytes (vertical tab, form feed, NUL, NBSP) are kept.
    for (const b of [0x0b, 0x0c, 0x00, 0xa0]) {
      const withByte = Buffer.from([0x61, b, 0x62]);
      expect(curseforgeFingerprint(withByte)).not.toBe(
        curseforgeFingerprint(Buffer.from('ab')),
      );
    }
  });

  it('is not the plain murmur2 of the raw bytes when whitespace is present', () => {
    const raw = Buffer.from('a b');
    expect(curseforgeFingerprint(raw)).not.toBe(murmur2(raw, 1));
  });

  it('hashes an all-whitespace buffer like an empty one', () => {
    expect(curseforgeFingerprint(Buffer.from(' \t\r\n'))).toBe(
      murmur2(Buffer.alloc(0), 1),
    );
  });
});
