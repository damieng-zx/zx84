/**
 * Teledisk disk images (.td0).
 *
 * Sydex's Teledisk archived a floppy as a list of tracks, each a list of
 * sectors carrying their CHRN, a flags byte and a compressed data field. It is
 * how a lot of CP/M software — including the Amstrad PCW boot discs — was
 * preserved, so the PCW reads it even though nothing else in this codebase
 * writes it.
 *
 * The file is:
 *
 *   12-byte header ─ 'TD' (stored plain) or 'td' (everything after the header
 *                    is LZHUF-compressed — Teledisk's "advanced compression")
 *   comment block  ─ optional, present when header[7] bit 7 is set
 *   track records  ─ until a track whose sector count is 0xFF (end of file)
 *
 * Three CRC-16s guard the file (poly 0xA097, MSB-first, init 0): one over the
 * header, one per track header, and one per sector's *decoded* data. The last
 * is the useful one — it validates the decompressor and the data encodings
 * together, so a wrong bit anywhere shows up immediately rather than as a
 * subtly corrupt disc. We check it and mark a failing sector as a data error
 * rather than rejecting the file, which is what a real FDC would report.
 *
 * Materialised as the shared DskImage so the uPD765A core, the disk UI and the
 * floppy-sound code are all reused unchanged.
 */

import type { DskImage, DskTrack, DskSector } from './disk-image.ts';
import { detectDiskFormat, detectProtection, isFlippyDisk } from './disk-detect.ts';

/** CP/M's formatted-but-empty byte, and the +3/PCW format gap — TD0 records
 *  neither, so mounted images use the same defaults `blankDisk` writes. */
const FILLER = 0xE5;
const GAP3 = 82;

/** Guards a corrupt length field from expanding into an unbounded buffer. */
const MAX_DECOMPRESSED = 8 * 1024 * 1024;

// ── Teledisk CRC-16 ─────────────────────────────────────────────────────────

/** CRC-16 with polynomial 0xA097, MSB-first, initial value 0. */
export function td0Crc(data: Uint8Array): number {
  let crc = 0;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0xA097) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return crc & 0xFFFF;
}

// ── LZHUF ("advanced compression") ──────────────────────────────────────────
//
// Haruyasu Yoshizaki's LZHUF: LZSS over a 4K ring buffer, with both the
// literal/length symbol and the match position entropy-coded — the literal by
// an adaptive Huffman tree that reshapes as it decodes, the position by a
// static prefix code. Teledisk uses it verbatim, minus LZHUF's own file header:
// there is no stored output length, so decoding simply runs until the input is
// exhausted.

const N = 4096;            // ring buffer size
const F = 60;              // longest match
const THRESHOLD = 2;       // shortest encoded match
const N_CHAR = 256 - THRESHOLD + F;  // 314 leaf symbols: 256 literals + lengths
const T = N_CHAR * 2 - 1;  // 627 tree nodes
const R = T - 1;           // 626, the root
const MAX_FREQ = 0x8000;   // rescale the tree when the root reaches this

/** Prefix-code lengths for the 64 possible top-6-bits-of-position symbols. */
const P_LEN = [
  3, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6,
  6, 6, 6, 6, 6, 6, 6, 6, 7, 7, 7, 7, 7, 7, 7, 7,
  7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
  8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8,
];

/** Those codes, left-aligned in a byte. */
const P_CODE = [
  0x00, 0x20, 0x30, 0x40, 0x50, 0x58, 0x60, 0x68,
  0x70, 0x78, 0x80, 0x88, 0x90, 0x94, 0x98, 0x9C,
  0xA0, 0xA4, 0xA8, 0xAC, 0xB0, 0xB4, 0xB8, 0xBC,
  0xC0, 0xC2, 0xC4, 0xC6, 0xC8, 0xCA, 0xCC, 0xCE,
  0xD0, 0xD2, 0xD4, 0xD6, 0xD8, 0xDA, 0xDC, 0xDE,
  0xE0, 0xE2, 0xE4, 0xE6, 0xE8, 0xEA, 0xEC, 0xEE,
  0xF0, 0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7,
  0xF8, 0xF9, 0xFA, 0xFB, 0xFC, 0xFD, 0xFE, 0xFF,
];

// The decoder reads eight bits at once and looks the byte up, so invert the
// code table into one entry per byte value: every byte sharing a code's leading
// P_LEN bits maps to that symbol. This reproduces LZHUF.C's hand-written
// 256-entry d_code/d_len tables exactly, and is checked end to end by decoding
// a real Teledisk stream in the tests.
const D_CODE = new Uint8Array(256);
const D_LEN = new Uint8Array(256);
for (let i = 0; i < 64; i++) {
  const span = 1 << (8 - P_LEN[i]);
  for (let b = P_CODE[i]; b < P_CODE[i] + span; b++) {
    D_CODE[b] = i;
    D_LEN[b] = P_LEN[i];
  }
}

/** Decompress Teledisk's LZHUF stream. Stops when `src` runs out. */
export function lzhufDecode(src: Uint8Array): Uint8Array {
  const freq = new Uint16Array(T + 1);
  const son = new Uint16Array(T);
  const prnt = new Uint16Array(T + N_CHAR);

  let getbuf = 0, getlen = 0, pos = 0, eof = false;

  // LZHUF's bit reader keeps a 16-bit window so a byte can be taken whole.
  function fill(): void {
    while (getlen <= 8) {
      let b = 0;
      if (pos < src.length) b = src[pos++]; else eof = true;
      getbuf = (getbuf | (b << (8 - getlen))) & 0xFFFF;
      getlen += 8;
    }
  }
  function getBit(): number {
    fill();
    const i = getbuf;
    getbuf = (getbuf << 1) & 0xFFFF;
    getlen--;
    return (i & 0x8000) ? 1 : 0;
  }
  function getByte(): number {
    fill();
    const i = getbuf;
    getbuf = (getbuf << 8) & 0xFFFF;
    getlen -= 8;
    return (i >> 8) & 0xFF;
  }

  // Every symbol starts equally likely; internal nodes hold running totals.
  for (let i = 0; i < N_CHAR; i++) {
    freq[i] = 1;
    son[i] = i + T;
    prnt[i + T] = i;
  }
  for (let i = 0, j = N_CHAR; j <= R; i += 2, j++) {
    freq[j] = freq[i] + freq[i + 1];
    son[j] = i;
    prnt[i] = prnt[i + 1] = j;
  }
  freq[T] = 0xFFFF;
  prnt[R] = 0;

  /** Halve every leaf count and rebuild, keeping the tree frequency-ordered. */
  function reconst(): void {
    let j = 0;
    for (let i = 0; i < T; i++) {
      if (son[i] >= T) {
        freq[j] = (freq[i] + 1) >> 1;
        son[j] = son[i];
        j++;
      }
    }
    for (let i = 0, k = N_CHAR; k < T; i += 2, k++) {
      const f = freq[k] = freq[i] + freq[i + 1];
      let l = k - 1;
      while (f < freq[l]) l--;
      l++;
      freq.copyWithin(l + 1, l, k);
      freq[l] = f;
      son.copyWithin(l + 1, l, k);
      son[l] = i;
    }
    for (let i = 0; i < T; i++) {
      const k = son[i];
      if (k >= T) prnt[k] = i; else prnt[k] = prnt[k + 1] = i;
    }
  }

  /** Bump symbol `c`'s count, bubbling it up past any node it now outweighs. */
  function update(c: number): void {
    if (freq[R] === MAX_FREQ) reconst();
    c = prnt[c + T];
    do {
      const k = ++freq[c];
      let l = c + 1;
      if (k > freq[l]) {
        while (k > freq[++l]);
        l--;
        freq[c] = freq[l];
        freq[l] = k;

        const i = son[c];
        prnt[i] = l;
        if (i < T) prnt[i + 1] = l;

        const j = son[l];
        son[l] = i;
        prnt[j] = c;
        if (j < T) prnt[j + 1] = c;

        son[c] = j;
        c = l;
      }
    } while ((c = prnt[c]) !== 0);
  }

  /** Walk the tree one bit at a time to a leaf: a literal, or a match length. */
  function decodeChar(): number {
    let c = son[R];
    while (c < T) {
      c += getBit();
      c = son[c];
    }
    c -= T;
    update(c);
    return c;
  }

  /** Top six bits of the match position come from the static code, the rest raw. */
  function decodePosition(): number {
    let i = getByte();
    const c = D_CODE[i] << 6;
    let j = D_LEN[i] - 2;
    while (j--) i = ((i << 1) + getBit()) & 0xFFFF;
    return c | (i & 0x3F);
  }

  const text = new Uint8Array(N).fill(0x20);
  const out: number[] = [];
  let r = N - F;

  while (!eof) {
    const c = decodeChar();
    if (c < 256) {
      out.push(c);
      text[r++] = c;
      r &= N - 1;
    } else {
      const start = (r - decodePosition() - 1) & (N - 1);
      const len = c - 255 + THRESHOLD;
      for (let k = 0; k < len; k++) {
        const b = text[(start + k) & (N - 1)];
        out.push(b);
        text[r++] = b;
        r &= N - 1;
      }
    }
    if (out.length > MAX_DECOMPRESSED) throw new Error('TD0: compressed stream too large');
  }

  return Uint8Array.from(out);
}

// ── Sector data encodings ───────────────────────────────────────────────────

/**
 * Expand one sector's stored data field. Teledisk picks whichever of three
 * encodings is smallest for the sector: a straight copy, one 2-byte pattern
 * repeated to fill the sector, or a run-length scheme alternating literal runs
 * with repeated multi-byte patterns.
 */
function expandSector(src: Uint8Array, encoding: number, size: number): Uint8Array {
  const out = new Uint8Array(size).fill(FILLER);

  if (encoding === 0) {
    out.set(src.subarray(0, Math.min(src.length, size)));
    return out;
  }

  if (encoding === 1) {
    if (src.length < 4) throw new Error('TD0: truncated repeat-encoded sector');
    const count = src[0] | (src[1] << 8);
    const a = src[2], b = src[3];
    let o = 0;
    for (let i = 0; i < count && o < size; i++) {
      out[o++] = a;
      if (o < size) out[o++] = b;
    }
    return out;
  }

  if (encoding === 2) {
    let i = 0, o = 0;
    while (i < src.length && o < size) {
      const kind = src[i++];
      if (kind === 0) {
        // Literal run: a count, then that many bytes verbatim.
        const n = src[i++];
        for (let k = 0; k < n && o < size; k++) out[o++] = src[i++];
      } else {
        // Repeat run: a 2×kind-byte pattern, repeated n times.
        const n = src[i++];
        const width = kind * 2;
        const pattern = src.subarray(i, i + width);
        i += width;
        for (let k = 0; k < n; k++) {
          for (let m = 0; m < pattern.length && o < size; m++) out[o++] = pattern[m];
        }
      }
    }
    return out;
  }

  throw new Error(`TD0: unknown sector encoding ${encoding}`);
}

// ── Sector flags ────────────────────────────────────────────────────────────

const FLAG_CRC_ERROR = 0x02;   // data field failed its CRC when dumped
const FLAG_DELETED = 0x04;     // deleted-data address mark
const FLAG_SKIPPED = 0x10;     // not dumped; no data field stored
const FLAG_NO_DATA = 0x20;     // no data address mark found on the disc
const FLAG_NO_ID = 0x40;       // no ID field found

/** A sector carries a stored data field unless it was skipped or had none. */
function hasDataField(flags: number): boolean {
  return (flags & (FLAG_SKIPPED | FLAG_NO_DATA)) === 0;
}

/** Teledisk's flags as the uPD765A status bytes the FDC core reports. */
function statusFor(flags: number): { st1: number; st2: number } {
  let st1 = 0, st2 = 0;
  if (flags & FLAG_CRC_ERROR) { st1 |= 0x20; st2 |= 0x20; }  // DE + DD
  if (flags & FLAG_DELETED) st2 |= 0x40;                     // CM (control mark)
  if (flags & FLAG_NO_DATA) { st1 |= 0x01; st2 |= 0x01; }    // MA + MD
  if (flags & FLAG_NO_ID) st1 |= 0x01;                       // MA
  return { st1, st2 };
}

// ── Parser ──────────────────────────────────────────────────────────────────

/** True when `data` opens with a Teledisk signature. */
export function isTd0(data: Uint8Array): boolean {
  if (data.length < 12) return false;
  const a = String.fromCharCode(data[0], data[1]);
  return a === 'TD' || a === 'td';
}

interface Td0Header {
  compressed: boolean;
  hasComment: boolean;
}

function parseHeader(data: Uint8Array): Td0Header {
  const sig = String.fromCharCode(data[0], data[1]);
  if (sig !== 'TD' && sig !== 'td') throw new Error('Not a Teledisk (.td0) image');

  if (td0Crc(data.subarray(0, 10)) !== (data[10] | (data[11] << 8))) {
    throw new Error('TD0: bad header CRC');
  }

  // A multi-volume set spans several files; we can only mount a whole disc.
  if (data[2] !== 0) throw new Error('TD0: multi-volume images are not supported');

  return {
    compressed: sig === 'td',
    hasComment: (data[7] & 0x80) !== 0,
  };
}

/** Parse a Teledisk image into a DskImage. Throws on a malformed file. */
export function parseTd0(data: Uint8Array): DskImage {
  const head = parseHeader(data);
  const body = head.compressed ? lzhufDecode(data.subarray(12)) : data.subarray(12);

  let p = 0;
  if (head.hasComment) {
    if (body.length < 10) throw new Error('TD0: truncated comment block');
    const len = body[2] | (body[3] << 8);
    p = 10 + len;
    if (p > body.length) throw new Error('TD0: truncated comment block');
  }

  // Collect tracks first — the geometry is whatever the records turn out to
  // describe, which is more reliable than the header's side count.
  const found = new Map<string, DskTrack>();
  let maxCyl = -1, maxHead = -1;

  for (;;) {
    if (p >= body.length) throw new Error('TD0: missing end-of-file marker');
    const count = body[p];
    if (count === 0xFF) break;
    if (p + 4 > body.length) throw new Error('TD0: truncated track header');

    const cyl = body[p + 1];
    const side = body[p + 2] & 1;   // high bits are flags, not the head number
    p += 4;

    const sectors: DskSector[] = [];
    const sectorMap = new Map<number, number>();

    for (let s = 0; s < count; s++) {
      if (p + 6 > body.length) throw new Error('TD0: truncated sector header');
      const c = body[p], h = body[p + 1], r = body[p + 2], n = body[p + 3];
      const flags = body[p + 4], crc = body[p + 5];
      p += 6;

      const size = n <= 8 ? 128 << n : 0;
      let { st1, st2 } = statusFor(flags);
      let sectorData: Uint8Array;

      if (hasDataField(flags)) {
        if (p + 3 > body.length) throw new Error('TD0: truncated sector data');
        const blockLen = (body[p] | (body[p + 1] << 8)) - 1;
        const encoding = body[p + 2];
        if (blockLen < 0 || p + 3 + blockLen > body.length) {
          throw new Error('TD0: truncated sector data');
        }
        sectorData = expandSector(body.subarray(p + 3, p + 3 + blockLen), encoding, size);
        p += 3 + blockLen;

        // The stored CRC is the low byte of the CRC over the decoded sector.
        // A mismatch means the dump recorded a bad read (or we mis-decoded),
        // so surface it the way the FDC would rather than failing the mount.
        if ((td0Crc(sectorData) & 0xFF) !== crc) { st1 |= 0x20; st2 |= 0x20; }
      } else {
        sectorData = new Uint8Array(size).fill(FILLER);
      }

      if (!sectorMap.has(r)) sectorMap.set(r, sectors.length);
      sectors.push({ c, h, r, n, st1, st2, data: sectorData });
    }

    found.set(`${cyl}:${side}`, { sectors, sectorMap, gap3: GAP3, filler: FILLER });
    if (cyl > maxCyl) maxCyl = cyl;
    if (side > maxHead) maxHead = side;
  }

  if (maxCyl < 0) throw new Error('TD0: image contains no tracks');

  const numTracks = maxCyl + 1;
  const numSides = Math.max(maxHead + 1, 1);
  const tracks: (DskTrack | null)[][] = [];
  for (let c = 0; c < numTracks; c++) {
    const sides: (DskTrack | null)[] = [];
    for (let h = 0; h < numSides; h++) sides.push(found.get(`${c}:${h}`) ?? null);
    tracks.push(sides);
  }

  const image: DskImage = {
    // Per-sector FDC status makes this an extended image in DSK terms.
    format: 'extended',
    numTracks,
    numSides,
    tracks,
    diskFormat: '',
    protection: '',
  };

  image.diskFormat = detectDiskFormat(image);
  image.protection = detectProtection(image);
  image.flippy = isFlippyDisk(image);
  return image;
}
