/**
 * Synchronous zlib (RFC 1950) / DEFLATE (RFC 1951) decoder.
 *
 * The rest of the codebase inflates through the browser DecompressionStream,
 * which is async. The TZX parser is synchronous (and called synchronously by
 * every machine's tape service), yet a TZX 0x18 CSW Recording block may carry
 * its pulse stream Z-RLE compressed — so it needs an inflater it can call
 * inline. Tape blocks are small, so a straightforward table-driven decoder is
 * plenty fast.
 */

// Length codes 257..285: base lengths and extra bits (RFC 1951 §3.2.5).
const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LEN_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
// Distance codes 0..29.
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
// Order in which code-length code lengths are transmitted (dynamic blocks).
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Canonical Huffman decoding table: symbol counts per length + symbols
 *  sorted by code. */
interface Huffman { counts: Uint16Array; symbols: Uint16Array; }

function buildHuffman(lengths: ArrayLike<number>, n: number): Huffman {
  const counts = new Uint16Array(16);
  for (let i = 0; i < n; i++) counts[lengths[i]]++;
  counts[0] = 0;
  const offs = new Uint16Array(16);
  for (let len = 1; len < 16; len++) offs[len] = offs[len - 1] + counts[len - 1];
  const symbols = new Uint16Array(n);
  for (let i = 0; i < n; i++) if (lengths[i] !== 0) symbols[offs[lengths[i]]++] = i;
  return { counts, symbols };
}

class Output {
  buf: Uint8Array;
  len = 0;
  constructor(private readonly max: number) {
    this.buf = new Uint8Array(Math.min(max, 1 << 16) || 1);
  }
  private grow(need: number): void {
    if (need > this.max) throw new Error(`Inflated data exceeds ${this.max} bytes`);
    let size = this.buf.length;
    while (size < need) size *= 2;
    const next = new Uint8Array(Math.min(size, this.max));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  push(b: number): void {
    if (this.len >= this.buf.length) this.grow(this.len + 1);
    this.buf[this.len++] = b;
  }
  copy(dist: number, length: number): void {
    if (dist > this.len) throw new Error('Invalid deflate distance');
    if (this.len + length > this.buf.length) this.grow(this.len + length);
    for (let i = 0; i < length; i++, this.len++) this.buf[this.len] = this.buf[this.len - dist];
  }
}

class BitReader {
  pos = 0;
  private bitBuf = 0;
  private bitCnt = 0;
  constructor(private readonly d: Uint8Array) {}
  bits(n: number): number {
    while (this.bitCnt < n) {
      if (this.pos >= this.d.length) throw new Error('Truncated deflate stream');
      this.bitBuf |= this.d[this.pos++] << this.bitCnt;
      this.bitCnt += 8;
    }
    const v = this.bitBuf & ((1 << n) - 1);
    this.bitBuf >>>= n;
    this.bitCnt -= n;
    return v;
  }
  /** Drop to the next byte boundary (stored blocks). */
  align(): void { this.bitBuf = 0; this.bitCnt = 0; }
  decode(h: Huffman): number {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= this.bits(1);
      const count = h.counts[len];
      if (code - count < first) return h.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('Invalid deflate Huffman code');
  }
}

let fixedLit: Huffman | null = null;
let fixedDist: Huffman | null = null;

function fixedTables(): [Huffman, Huffman] {
  if (!fixedLit || !fixedDist) {
    const l = new Uint8Array(288);
    l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
    fixedLit = buildHuffman(l, 288);
    fixedDist = buildHuffman(new Uint8Array(30).fill(5), 30);
  }
  return [fixedLit, fixedDist];
}

function inflateBlockData(r: BitReader, out: Output, lit: Huffman, dist: Huffman): void {
  for (;;) {
    const sym = r.decode(lit);
    if (sym < 256) { out.push(sym); continue; }
    if (sym === 256) return;
    const li = sym - 257;
    if (li >= 29) throw new Error('Invalid deflate length code');
    const length = LEN_BASE[li] + r.bits(LEN_EXTRA[li]);
    const di = r.decode(dist);
    if (di >= 30) throw new Error('Invalid deflate distance code');
    out.copy(DIST_BASE[di] + r.bits(DIST_EXTRA[di]), length);
  }
}

function dynamicTables(r: BitReader): [Huffman, Huffman] {
  const hlit = r.bits(5) + 257;
  const hdist = r.bits(5) + 1;
  const hclen = r.bits(4) + 4;
  const clen = new Uint8Array(19);
  for (let i = 0; i < hclen; i++) clen[CLEN_ORDER[i]] = r.bits(3);
  const clHuff = buildHuffman(clen, 19);
  const lengths = new Uint8Array(hlit + hdist);
  for (let i = 0; i < hlit + hdist;) {
    const sym = r.decode(clHuff);
    if (sym < 16) { lengths[i++] = sym; continue; }
    let rep: number, val = 0;
    if (sym === 16) {
      if (i === 0) throw new Error('Invalid deflate code-length repeat');
      val = lengths[i - 1];
      rep = 3 + r.bits(2);
    } else if (sym === 17) {
      rep = 3 + r.bits(3);
    } else {
      rep = 11 + r.bits(7);
    }
    if (i + rep > hlit + hdist) throw new Error('Invalid deflate code lengths');
    while (rep--) lengths[i++] = val;
  }
  return [buildHuffman(lengths, hlit), buildHuffman(lengths.subarray(hlit), hdist)];
}

/** Decode a raw DEFLATE stream starting at `r`. */
function inflateRaw(r: BitReader, d: Uint8Array, out: Output): void {
  let last = 0;
  while (!last) {
    last = r.bits(1);
    const type = r.bits(2);
    if (type === 0) {
      r.align();
      if (r.pos + 4 > d.length) throw new Error('Truncated deflate stream');
      const len = d[r.pos] | (d[r.pos + 1] << 8);
      const nlen = d[r.pos + 2] | (d[r.pos + 3] << 8);
      if ((len ^ 0xFFFF) !== nlen) throw new Error('Corrupt deflate stored block');
      r.pos += 4;
      if (r.pos + len > d.length) throw new Error('Truncated deflate stream');
      for (let i = 0; i < len; i++) out.push(d[r.pos + i]);
      r.pos += len;
    } else if (type === 1) {
      const [lit, dist] = fixedTables();
      inflateBlockData(r, out, lit, dist);
    } else if (type === 2) {
      const [lit, dist] = dynamicTables(r);
      inflateBlockData(r, out, lit, dist);
    } else {
      throw new Error('Invalid deflate block type');
    }
  }
}

/**
 * Inflate a zlib-wrapped stream (2-byte header, DEFLATE data, Adler-32).
 * Throws on a malformed header or stream, or once the output would exceed
 * `maxOutput` bytes (a guard against decompression bombs).
 */
export function inflateZlibSync(data: Uint8Array, maxOutput: number): Uint8Array {
  if (data.length < 2) throw new Error('Truncated zlib stream');
  const cmf = data[0], flg = data[1];
  if ((cmf & 0x0F) !== 8 || ((cmf << 8) | flg) % 31 !== 0) throw new Error('Not a zlib stream');
  if (flg & 0x20) throw new Error('zlib preset dictionaries are not supported');
  const r = new BitReader(data);
  r.pos = 2;
  const out = new Output(maxOutput);
  inflateRaw(r, data, out);
  return out.buf.slice(0, out.len);
}
