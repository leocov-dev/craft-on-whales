// CurseForge file fingerprints, computed locally so a jar can be reverse-looked
// up with POST /v1/fingerprints/{gameId} (CurseforgeApiService.getFingerprintMatches).
//
// The algorithm is 32-bit MurmurHash2 (Austin Appleby's original, not
// MurmurHash3 / MurmurHash64A) with seed 1, run over the file's bytes after
// every whitespace byte (0x09 tab, 0x0a LF, 0x0d CR, 0x20 space) has been
// dropped. The length mixed into the initial state is the length *after*
// stripping. That normalization dates from CurseForge's text-file handling
// and applies to binary jars too: hashing the raw bytes gives a number that
// never matches. Pure functions, no I/O.

const M = 0x5bd1e995;

/** 32-bit MurmurHash2 over `data`, returned as an unsigned integer. */
export function murmur2(data: Uint8Array, seed: number): number {
  const len = data.length;
  let h = (seed ^ len) >>> 0;
  let i = 0;
  for (; i + 4 <= len; i += 4) {
    let k =
      data[i]! |
      (data[i + 1]! << 8) |
      (data[i + 2]! << 16) |
      (data[i + 3]! << 24);
    k = Math.imul(k, M);
    k ^= k >>> 24;
    k = Math.imul(k, M);
    h = Math.imul(h, M) ^ k;
  }
  // Tail bytes (the reference C's case 3 -> 2 -> 1 fallthrough).
  const rest = len - i;
  if (rest >= 3) h ^= data[i + 2]! << 16;
  if (rest >= 2) h ^= data[i + 1]! << 8;
  if (rest >= 1) {
    h ^= data[i]!;
    h = Math.imul(h, M);
  }
  h ^= h >>> 13;
  h = Math.imul(h, M);
  h ^= h >>> 15;
  return h >>> 0;
}

function isCurseforgeWhitespace(b: number): boolean {
  return b === 0x09 || b === 0x0a || b === 0x0d || b === 0x20;
}

/** The fingerprint CurseForge stores as `file.fileFingerprint` for these bytes. */
export function curseforgeFingerprint(buffer: Uint8Array): number {
  const kept = Buffer.allocUnsafe(buffer.length);
  let n = 0;
  for (const b of buffer) if (!isCurseforgeWhitespace(b)) kept[n++] = b;
  return murmur2(kept.subarray(0, n), 1);
}
