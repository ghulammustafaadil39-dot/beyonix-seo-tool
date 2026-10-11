/**
 * Minimal QR Code generator — byte mode, ECC level M, versions 1–10.
 *
 * Dependency-free (no npm packages). Used to render the TOTP otpauth:// URL
 * as a QR code during 2FA enrollment. Everything else (authenticator app
 * scan compatibility) is standard QR; the encoder is validated against the
 * reference `qrcode` npm implementation in a throwaway /tmp harness.
 */

// ---------- GF(256) arithmetic ----------

const EXP = new Array<number>(512);
const LOG = new Array<number>(256);
(function initTables() {
  let x = 1;
  for (let i = 0; i < 512; i++) {
    EXP[i] = x;
    if (i < 255) LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function polyMul(p: number[], q: number[]): number[] {
  const r = new Array<number>(p.length + q.length - 1).fill(0);
  for (let i = 0; i < p.length; i++)
    for (let j = 0; j < q.length; j++) r[i + j] ^= gfMul(p[i], q[j]);
  return r;
}

function rsGenerator(degree: number): number[] {
  let g = [1];
  for (let i = 0; i < degree; i++) g = polyMul(g, [1, EXP[i]]);
  return g;
}

/** Reed–Solomon remainder of data ÷ generator. */
function rsRemainder(data: number[], gen: number[]): number[] {
  const r = new Array<number>(gen.length - 1).fill(0);
  for (const d of data) {
    const f = d ^ (r.shift() as number);
    r.push(0);
    for (let i = 0; i < gen.length - 1; i++) r[i] ^= gfMul(gen[i + 1], f);
  }
  return r;
}

// ---------- Version table (ECC level M, byte mode) ----------

interface VersionSpec {
  version: number;
  /** Total codewords (data + ECC) in the symbol. */
  totalCodewords: number;
  /** Total ECC codewords across all blocks. */
  ecTotal: number;
  /** Number of RS blocks. */
  blocks: number;
  align: number[];
}

// ECC level M characteristics (ISO 18004 Table 9). Block subdivision
// follows the standard algorithm (see interleave()): group 2 holds
// totalCodewords % blocks blocks, each with one extra data codeword.
const VERSIONS: VersionSpec[] = [
  { version: 1, totalCodewords: 26, ecTotal: 10, blocks: 1, align: [] },
  { version: 2, totalCodewords: 44, ecTotal: 16, blocks: 1, align: [6, 18] },
  { version: 3, totalCodewords: 70, ecTotal: 26, blocks: 1, align: [6, 22] },
  { version: 4, totalCodewords: 100, ecTotal: 36, blocks: 2, align: [6, 26] },
  { version: 5, totalCodewords: 134, ecTotal: 48, blocks: 2, align: [6, 30] },
  { version: 6, totalCodewords: 172, ecTotal: 64, blocks: 4, align: [6, 34] },
  { version: 7, totalCodewords: 196, ecTotal: 72, blocks: 4, align: [6, 22, 38] },
  { version: 8, totalCodewords: 242, ecTotal: 88, blocks: 4, align: [6, 24, 42] },
  { version: 9, totalCodewords: 292, ecTotal: 110, blocks: 5, align: [6, 26, 46] },
  { version: 10, totalCodewords: 346, ecTotal: 130, blocks: 5, align: [6, 28, 50] },
];

function dataCodewordsTotal(spec: VersionSpec): number {
  return spec.totalCodewords - spec.ecTotal;
}

// ---------- Data encoding (byte mode) ----------

function encodeDataCodewords(text: string, spec: VersionSpec): number[] {
  const bytes = new TextEncoder().encode(text);
  const capacity = dataCodewordsTotal(spec) * 8;
  const bits: number[] = [];
  const push = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, spec.version <= 9 ? 8 : 16); // character count
  for (const b of bytes) push(b, 8);
  const terminator = Math.min(4, capacity - bits.length);
  push(0, terminator);
  while (bits.length % 8 !== 0) bits.push(0);
  const cw: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    cw.push(v);
  }
  let p = 0;
  while (cw.length < dataCodewordsTotal(spec)) {
    cw.push(p % 2 === 0 ? 0xec : 0x11);
    p++;
  }
  return cw;
}

/**
 * Split data codewords into RS blocks and interleave (data, then ECC).
 * Block subdivision is the ISO 18004 algorithm: group 2 holds
 * (totalCodewords % blocks) blocks and each of its blocks carries one
 * extra data codeword; every block carries the same ECC count.
 */
function interleave(data: number[], spec: VersionSpec): number[] {
  const dataTotal = dataCodewordsTotal(spec);
  const blocksInGroup2 = spec.totalCodewords % spec.blocks;
  const blocksInGroup1 = spec.blocks - blocksInGroup2;
  const dataInGroup1 = Math.floor(dataTotal / spec.blocks);
  const dataInGroup2 = dataInGroup1 + 1;
  const ecCount = Math.floor(spec.totalCodewords / spec.blocks) - dataInGroup1;
  const gen = rsGenerator(ecCount);
  const blockData: number[][] = [];
  const blockEcc: number[][] = [];
  let offset = 0;
  for (let b = 0; b < spec.blocks; b++) {
    const size = b < blocksInGroup1 ? dataInGroup1 : dataInGroup2;
    const chunk = data.slice(offset, offset + size);
    offset += size;
    blockData.push(chunk);
    blockEcc.push(rsRemainder(chunk, gen));
  }
  const out: number[] = [];
  const maxData = Math.max(...blockData.map((c) => c.length));
  for (let i = 0; i < maxData; i++)
    for (const c of blockData) if (i < c.length) out.push(c[i]);
  for (let i = 0; i < ecCount; i++) for (const c of blockEcc) out.push(c[i]);
  return out;
}

// ---------- Matrix construction ----------

type Matrix = boolean[][];

function buildBaseMatrix(size: number): { modules: Matrix; func: boolean[][] } {
  const modules: Matrix = Array.from({ length: size }, () => new Array(size).fill(false));
  const func: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r: number, c: number, v: boolean, f = true) => {
    modules[r][c] = v;
    if (f) func[r][c] = true;
  };
  // 7x7 finder: dark border + dark 3x3 center, white separator ring around it.
  const drawFinder = (r0: number, c0: number) => {
    for (let r = 0; r < 7; r++)
      for (let c = 0; c < 7; c++) {
        const edge = r === 0 || r === 6 || c === 0 || c === 6;
        const center = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(r0 + r, c0 + c, edge || center);
      }
    // white separator ring
    for (let i = -1; i <= 7; i++) {
      if (r0 + i >= 0 && r0 + i < size) {
        if (c0 - 1 >= 0) set(r0 + i, c0 - 1, false);
        if (c0 + 7 < size) set(r0 + i, c0 + 7, false);
      }
      if (c0 + i >= 0 && c0 + i < size) {
        if (r0 - 1 >= 0) set(r0 - 1, c0 + i, false);
        if (r0 + 7 < size) set(r0 + 7, c0 + i, false);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);
  // timing
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0;
    set(6, i, v);
    set(i, 6, v);
  }
  return { modules, func };
}

function addAlignment(modules: Matrix, func: boolean[][], pos: number[]) {
  const n = pos.length;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      // skip the three corners that overlap finder patterns
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      const r0 = pos[i] - 2;
      const c0 = pos[j] - 2;
      for (let r = 0; r < 5; r++)
        for (let c = 0; c < 5; c++) {
          const edge = r === 0 || r === 4 || c === 0 || c === 4;
          modules[r0 + r][c0 + c] = edge || (r === 2 && c === 2);
          func[r0 + r][c0 + c] = true;
        }
    }
}

/** 15-bit format info for ECC level M (00) + mask. */
function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask; // ECL M = 00
  let rem = data << 10;
  const g = 0b10100110111;
  for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= g << (i - 10);
  return (((data << 10) | (rem & 0x3ff)) ^ 0b101010000010010) & 0x7fff;
}

/** 18-bit version info (versions 7+). */
function versionBits(version: number): number {
  let rem = version << 12;
  const g = 0b1111100100101;
  for (let i = 17; i >= 12; i--) if ((rem >> i) & 1) rem ^= g << (i - 12);
  return ((version << 12) | (rem & 0xfff)) & 0x3ffff;
}

function addFormatInfo(modules: Matrix, func: boolean[][], mask: number) {
  const size = modules.length;
  const bits = formatBits(mask);
  const set = (r: number, c: number, i: number) => {
    modules[r][c] = ((bits >> i) & 1) === 1;
    func[r][c] = true;
  };
  // Copy 1 (around the top-left finder): bits 0-5 run DOWN column 8,
  // bits 9-14 run LEFT along row 8.
  for (let i = 0; i < 6; i++) set(i, 8, i); // bits 0-5
  set(7, 8, 6); // bit 6
  set(8, 8, 7); // bit 7
  set(8, 7, 8); // bit 8
  for (let i = 0; i < 6; i++) set(8, 5 - i, 9 + i); // bits 9-14
  // Copy 2: bits 0-7 along row 8 (top-right) + bits 8-14 down column 8
  // (bottom-left).
  for (let i = 0; i < 8; i++) set(8, size - 1 - i, i); // bits 0-7
  for (let i = 8; i < 15; i++) set(size - 15 + i, 8, i); // bits 8-14
  // dark module
  modules[size - 8][8] = true;
  func[size - 8][8] = true;
}

function addVersionInfo(modules: Matrix, func: boolean[][], version: number) {
  if (version < 7) return;
  const size = modules.length;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const v = ((bits >> i) & 1) === 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    modules[r][size - 11 + c] = v; // top-right 6x3
    func[r][size - 11 + c] = true;
    modules[size - 11 + c][r] = v; // bottom-left 3x6
    func[size - 11 + c][r] = true;
  }
}

const MASKS: Array<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function placeData(modules: Matrix, func: boolean[][], codewords: number[], mask: number) {
  const size = modules.length;
  const bits: number[] = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
  let bi = 0;
  const maskFn = MASKS[mask];
  // Standard zigzag: column pairs right-to-left, alternating up/down,
  // skipping the vertical timing column (6).
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const row = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        if (func[row][col]) continue;
        let dark = bi < bits.length ? bits[bi] === 1 : false;
        bi++;
        if (maskFn(row, col)) dark = !dark;
        modules[row][col] = dark;
      }
    }
  }
}

function penalty(modules: Matrix): number {
  const size = modules.length;
  let score = 0;
  // N1: runs of 5+ in rows/cols
  for (let r = 0; r < size; r++) {
    let run = 1;
    for (let c = 1; c < size; c++) {
      if (modules[r][c] === modules[r][c - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  for (let c = 0; c < size; c++) {
    let run = 1;
    for (let r = 1; r < size; r++) {
      if (modules[r][c] === modules[r - 1][c]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  // N2: 2x2 blocks
  for (let r = 0; r < size - 1; r++)
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r][c];
      if (modules[r][c + 1] === v && modules[r + 1][c] === v && modules[r + 1][c + 1] === v) score += 3;
    }
  // N3: finder-like patterns
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const match = (line: boolean[], i: number, pat: number[]) => {
    for (let k = 0; k < 11; k++) if ((line[i + k] ? 1 : 0) !== pat[k]) return false;
    return true;
  };
  for (let r = 0; r < size; r++) {
    const line = modules[r];
    for (let c = 0; c <= size - 11; c++)
      if (match(line, c, pat1) || match(line, c, pat2)) score += 40;
  }
  for (let c = 0; c < size; c++) {
    const line = modules.map((row) => row[c]);
    for (let r = 0; r <= size - 11; r++)
      if (match(line, r, pat1) || match(line, r, pat2)) score += 40;
  }
  // N4: dark ratio
  let dark = 0;
  for (const row of modules) for (const v of row) if (v) dark++;
  const total = size * size;
  const k = Math.floor((Math.abs(dark * 20 - total * 10) + total - 1) / total);
  score += k * 10;
  return score;
}

export interface QrResult {
  /** size × size boolean matrix (true = dark module), no quiet zone. */
  modules: Matrix;
  size: number;
  version: number;
  mask: number;
}

/** Encode text as a QR code (byte mode, ECC M). Throws if text exceeds version-10 capacity. */
export function encodeQr(text: string): QrResult {
  const byteLen = new TextEncoder().encode(text).length;
  const spec = VERSIONS.find((v) => {
    const countBits = v.version <= 9 ? 8 : 16;
    return Math.floor((dataCodewordsTotal(v) * 8 - 4 - countBits) / 8) >= byteLen;
  });
  if (!spec) throw new Error('Text too long for QR code (max version 10, ECC M)');
  const size = spec.version * 4 + 17;
  const dataCw = encodeDataCodewords(text, spec);
  const all = interleave(dataCw, spec);

  let best: QrResult | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const { modules, func } = buildBaseMatrix(size);
    addAlignment(modules, func, spec.align);
    addVersionInfo(modules, func, spec.version);
    // Format info BEFORE data: those cells are reserved (function modules),
    // so placeData skips them. Drawing format after data would silently
    // overwrite data bits and produce an undecodable symbol.
    addFormatInfo(modules, func, mask);
    placeData(modules, func, all, mask);
    const s = penalty(modules);
    if (s < bestScore) {
      bestScore = s;
      best = { modules, size, version: spec.version, mask };
    }
  }
  return best as QrResult;
}
