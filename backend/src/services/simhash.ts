// Simhash for near-duplicate content detection (C-04).
// 64-bit simhash over word tokens hashed with FNV-1a 64. Pages whose
// fingerprints differ by <= threshold bits are near-duplicates.
// Pure — no network.

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

function fnv1a64(token: string): bigint {
  let h = FNV_OFFSET;
  for (let i = 0; i < token.length; i++) {
    h ^= BigInt(token.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

/** 64-bit simhash of text, returned as a 16-char hex string. */
export function simhash64(text: string): string {
  const tokens = tokenize(text);
  const sums = new Array<number>(64).fill(0);
  for (const tok of tokens) {
    const h = fnv1a64(tok);
    for (let i = 0; i < 64; i++) {
      sums[i] += (h >> BigInt(i)) & 1n ? 1 : -1;
    }
  }
  let out = 0n;
  for (let i = 0; i < 64; i++) {
    if (sums[i] > 0) out |= 1n << BigInt(i);
  }
  return out.toString(16).padStart(16, '0');
}

function hexToBigint(hex: string): bigint {
  return BigInt('0x' + hex);
}

/** Hamming distance between two simhash hex strings. */
export function hammingDistance(a: string, b: string): number {
  let x = hexToBigint(a) ^ hexToBigint(b);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

export const NEAR_DUPLICATE_THRESHOLD = 8;

/** True when two pages are near-duplicates (threshold bits or fewer differ). */
export function isNearDuplicate(a: string, b: string, threshold = NEAR_DUPLICATE_THRESHOLD): boolean {
  if (!a || !b || a.length !== 16 || b.length !== 16) return false;
  return hammingDistance(a, b) <= threshold;
}

/**
 * Groups pages into near-duplicate clusters. Input: [{url, simhash}].
 * Output: clusters of >= 2 urls (singletons dropped).
 */
export function clusterNearDuplicates(
  pages: Array<{ url: string; simhash: string }>,
  threshold = NEAR_DUPLICATE_THRESHOLD,
): string[][] {
  const clusters: Array<{ rep: string; urls: string[] }> = [];
  for (const p of pages) {
    if (!p.simhash) continue;
    let placed = false;
    for (const c of clusters) {
      if (isNearDuplicate(p.simhash, c.rep, threshold)) {
        c.urls.push(p.url);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ rep: p.simhash, urls: [p.url] });
  }
  return clusters.filter((c) => c.urls.length >= 2).map((c) => c.urls);
}
