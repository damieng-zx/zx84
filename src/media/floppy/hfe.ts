/**
 * HFE (HxC Floppy Emulator) disk image support — native bitstream track model.
 *
 * HFE is a *track-level* format: it stores the raw bit-cell stream for every
 * track/side, exactly as the floppy read head sees it, rather than decoded
 * sectors. zx84's FDC cores drive off the sector-level {@link DskTrack}, so this
 * loader keeps the HFE bitstream as the disk's identity (attached to the
 * returned image as {@link HfeBitstream}) and decodes each track the way real
 * hardware does — hunting address-mark syncs, reading the ID field (CHRN + CRC)
 * and the following data field (honouring deleted-data marks, CRC errors, odd
 * sector sizes and track wrap-around). No DSK file is produced and the DSK code
 * path is never involved; the mounted disk *is* the HFE.
 *
 * Encodings: ISO/IBM double-density MFM (IBM System 34 — +3, CPC, PCW, MSX,
 * Enterprise, ADFS) and single-density FM (IBM 3740 — the BBC Micro's 8271 and
 * Acorn DFS). A track is tried as MFM first and as FM when no MFM sector is
 * found. FM is accepted both at its own cell rate and at the double-density
 * rate (two cells per FM clock or data window), which is how HxC and
 * Greaseweazle store FM in an HFE.
 *
 * Versions: HFE v1 ("HXCPICFE") and HFE v3 ("HXCHFEV3"). v3 adds an opcode
 * stream inside the track data (see {@link expandHfeV3}): NOP, SETINDEX,
 * SETBITRATE, SKIPBITS and RAND. RAND bytes are weak bits — they read
 * differently every revolution — so a v3 track that has them is decoded over
 * several random fills and a sector whose data changes between them carries
 * every reading as a weak `copies[]`, as the SCP flux path does. A v3 image is
 * saved back as v1 (the weak areas are then fixed to one reading).
 *
 * Format reference: the HxC "HFE (HxC Floppy Emulator) file format" spec and
 * its v3 opcode addendum.
 */

import { parseDSK, createBlankDisk, type DiskFormat } from './dsk.ts';
import type { DskImage, DskSector, DskTrack, HfeBitstream, HfeSectorLayout } from './disk-image.ts';
import { detectDiskFormat, detectProtection, isFlippyDisk } from './disk-detect.ts';
import { isScp, parseSCP, mergeRevolutions } from './scp.ts';
import { isTd0, parseTd0 } from './td0.ts';

// ── Signatures ───────────────────────────────────────────────────────────────

const SIG_V1 = 'HXCPICFE';   // classic HFE (v1)
const SIG_V3 = 'HXCHFEV3';   // HFE v3 — v1 layout plus an in-track opcode stream

/** True if the byte buffer begins with a recognised HFE signature. */
export function isHFE(data: Uint8Array): boolean {
  if (data.length < 8) return false;
  const sig = asciiAt(data, 0, 8);
  return sig === SIG_V1 || sig === SIG_V3;
}

// ── Little helpers ───────────────────────────────────────────────────────────

function asciiAt(data: Uint8Array, offset: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(data[offset + i]);
  return s;
}

function u16LE(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8);
}

/**
 * CRC-16-CCITT (poly 0x1021, init 0xFFFF, MSB-first) as used for FM and MFM
 * address and data field CRCs. Fed the address-mark bytes (A1 A1 A1 for MFM;
 * nothing for FM) plus the mark and the field body, the result is compared
 * against the field's own stored 16-bit CRC.
 */
function crc16(bytes: number[]): number {
  let crc = 0xFFFF;
  for (const b of bytes) {
    crc ^= (b & 0xFF) << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  return crc & 0xFFFF;
}

// ── MFM bit-cell access ──────────────────────────────────────────────────────
//
// Within an HFE track byte the cells are stored LSB-first: bit 0 is the first
// cell in time. An MFM-encoded byte occupies 16 cells laid out as
// clock,data,clock,data,… so the eight data bits sit at the odd cell offsets
// 1,3,…,15 (MSB first). The A1 address-mark sync — an A1 with a deliberately
// missing clock — is the 16-cell pattern 0x4489; decoding its data cells yields
// 0xA1, and locking onto it establishes the byte phase for everything after.
//
// The track is a *circle*: the head keeps spinning, so a field that starts near
// the end of the stream wraps to the beginning. All cell access is therefore
// modulo the bit count.

const MFM_SYNC_A1 = 0x4489;

function readBit(bytes: Uint8Array, bit: number, nbits: number): number {
  const b = bit % nbits;
  return (bytes[b >> 3] >> (b & 7)) & 1;
}

/** The 16 cells starting at bit position `p`, most-significant cell first. */
function cells16(bytes: Uint8Array, p: number, nbits: number): number {
  let v = 0;
  for (let i = 0; i < 16; i++) v = (v << 1) | readBit(bytes, p + i, nbits);
  return v;
}

/** Decode one data byte (16 cells at `p`), taking the eight data cells. */
function decodeByte(bytes: Uint8Array, p: number, nbits: number): number {
  let b = 0;
  for (let i = 0; i < 8; i++) b = (b << 1) | readBit(bytes, p + 1 + i * 2, nbits);
  return b;
}

/**
 * True if an A1 address-mark sync begins at bit position `p`. A single A1
 * (the 0x4489 missing-clock pattern) is sufficient and reliable: that pattern
 * cannot occur in legally-encoded MFM data at any phase, so one is enough to
 * mark a sync. Real writers emit 3, but worn/odd disks emit 2 — and hxcfe locks
 * onto those too, so requiring 3 would silently drop valid sectors.
 */
function isSyncAt(bytes: Uint8Array, p: number, nbits: number): boolean {
  return cells16(bytes, p, nbits) === MFM_SYNC_A1;
}

/**
 * First address-mark sync strictly within (from, limit), or -1. Because the A1
 * sync's missing clock cannot occur in legally-encoded MFM data, any match here
 * is a *real* following address mark — so it safely bounds a data field whose
 * declared size overruns the next sector (a short-sector protection trick).
 */
function findNextSync(bytes: Uint8Array, from: number, limit: number, nbits: number): number {
  for (let q = from; q < limit; q++) if (isSyncAt(bytes, q, nbits)) return q;
  return -1;
}

// ── Track de-interleave ──────────────────────────────────────────────────────
//
// Track data is stored as alternating 256-byte blocks: side 0, side 1, side 0,…
// `trackLen` counts both sides together (a single-sided image still carries
// empty side-1 blocks). Reassemble each side's contiguous bit-cell stream.

function extractSide(data: Uint8Array, start: number, trackLen: number, side: number): Uint8Array {
  const out: number[] = [];
  const end = Math.min(start + trackLen, data.length);
  let block = 0;
  for (let pos = start; pos < end; pos += 256, block++) {
    if ((block & 1) !== side) continue;
    const chunkEnd = Math.min(pos + 256, end);
    for (let i = pos; i < chunkEnd; i++) out.push(data[i]);
  }
  return Uint8Array.from(out);
}

// ── MFM track decode ─────────────────────────────────────────────────────────

/** Largest data field we will read from one ID (guards against a rogue N). */
const MAX_SECTOR_BYTES = 16384;

/**
 * How far past the index the scan follows an ID field whose data field hasn't
 * been seen yet (in bytes of the track encoding). The data mark trails its ID
 * by gap 2 + the sync run + the marks (~38 bytes on a standard MFM track, ~18
 * on FM); 64 bytes leaves headroom for a stretched gap 2 without reaching into
 * the track's first real sector.
 */
const WRAP_SEARCH_BYTES = 64;

/** True for a data address mark that means deleted data. MFM uses F8; FM
 *  controllers also treat F9 as deleted (FA is an ordinary data mark). */
function isDeletedMark(mark: number): boolean {
  return mark === 0xF8 || mark === 0xF9;
}

/** The DskSector status bits for a data field: ST1 DE + ST2 DD for a bad CRC,
 *  ST2 CM for a deleted-data mark. */
function fieldStatus(dataBad: boolean, mark: number): { st1: number; st2: number } {
  let st1 = 0;
  let st2 = 0;
  if (dataBad) { st1 |= 0x20; st2 |= 0x20; }
  if (isDeletedMark(mark)) st2 |= 0x40;
  return { st1, st2 };
}

/** Decode one side's MFM bit-cell stream (circular, `nbits` cells long). */
function decodeMfmTrack(cells: Uint8Array, nbits: number, layoutOut?: HfeSectorLayout[]): DskTrack | null {
  const sectors: DskSector[] = [];
  const sectorMap = new Map<number, number>();

  // Pending ID address field awaiting its matching data field.
  let pending: { c: number; h: number; r: number; n: number } | null = null;

  // Scan one full revolution for address-mark syncs. If the revolution ends
  // between an ID field and its data field — the last sector's data straddles
  // the index — keep following the circular track past the index to pick that
  // data field up rather than dropping the sector.
  let p = 0;
  while (p < nbits || (pending !== null && p < nbits + WRAP_SEARCH_BYTES * 16)) {
    // Lock onto an A1 sync, then consume the run of A1s (1..3) so the address
    // mark is read whatever the preamble length.
    if (!isSyncAt(cells, p, nbits)) {
      p++;
      continue;
    }
    let q = p;
    for (let n = 0; n < 8 && cells16(cells, q, nbits) === MFM_SYNC_A1; n++) q += 16;
    const mark = decodeByte(cells, q, nbits);
    const body = q + 16; // first field byte after the A1 run + mark

    if (mark === 0xFE) {
      // Past the index, the next ID is the track's first sector coming round
      // again: the pending ID never had a data field.
      if (p >= nbits) break;
      // ID address field: C H R N CRChi CRClo.
      const c = decodeByte(cells, body, nbits);
      const h = decodeByte(cells, body + 16, nbits);
      const r = decodeByte(cells, body + 32, nbits);
      const n = decodeByte(cells, body + 48, nbits);
      const crcStored = (decodeByte(cells, body + 64, nbits) << 8) | decodeByte(cells, body + 80, nbits);
      // Reject a bad-CRC ID field outright — the FDC can't trust its R, and it
      // is almost always a false sync detected inside gap/data. Accepting it
      // would shadow the real sector and derail the parse for the whole track.
      if (crc16([0xA1, 0xA1, 0xA1, 0xFE, c, h, r, n]) === crcStored) {
        pending = { c, h, r, n };
      }
      p = body + 6 * 16;
      continue;
    }

    if (mark === 0xFB || mark === 0xF8) {
      // Data (0xFB) or deleted-data (0xF8) field for the pending ID.
      if (!pending) { p = body; continue; }
      const declared = Math.min(128 << (pending.n & 0x0F), MAX_SECTOR_BYTES);

      // The data field runs for `declared` bytes unless the next address mark
      // arrives first — a short-sector protection whose N field lies about the
      // real length. Cap the read there so a bogus giant N can't swallow the
      // rest of the track.
      const nextSync = findNextSync(cells, body, body + (declared + 2) * 16, nbits);
      const truncated = nextSync >= 0;
      const size = truncated ? Math.min(declared, Math.floor((nextSync - body) / 16)) : declared;

      const payload = new Uint8Array(size);
      for (let i = 0; i < size; i++) payload[i] = decodeByte(cells, body + i * 16, nbits);
      // A truncated field can't have a valid CRC (its real CRC is unknown); flag
      // it as a data error, as hardware would on the short read.
      const dataBad = truncated || crc16([0xA1, 0xA1, 0xA1, mark, ...payload]) !==
        ((decodeByte(cells, body + size * 16, nbits) << 8) | decodeByte(cells, body + size * 16 + 16, nbits));

      const { st1, st2 } = fieldStatus(dataBad, mark);
      const sector: DskSector = { c: pending.c, h: pending.h, r: pending.r, n: pending.n, st1, st2, data: payload };
      const idx = sectors.push(sector) - 1;
      // Record where this data field lives so a write can be spliced back in.
      layoutOut?.push({ dataBit: body, len: size, mark });
      // First physical occurrence wins on duplicate IDs, matching real hardware.
      if (!sectorMap.has(sector.r)) sectorMap.set(sector.r, idx);

      pending = null;
      p = truncated ? nextSync : body + (size + 2) * 16;
      continue;
    }

    // A sync we don't consume as ID/data (e.g. an index/other mark) — step
    // past this mark and keep scanning.
    p = body;
  }

  if (sectors.length === 0) return null;
  return { sectors, sectorMap, gap3: 0x52, filler: 0xE5, encoding: 'mfm' };
}

// ── FM track decode ──────────────────────────────────────────────────────────
//
// FM (IBM 3740) gives every data bit two windows: a clock window that always
// holds a flux transition, then a data window that holds one for a 1. A byte is
// therefore 16 windows, clock first, MSB first. Address marks are bytes whose
// clock pattern has transitions deliberately left out — 0xC7 for the ID mark
// (data 0xFE) and the data marks (0xFB / 0xF8, and 0xFA / 0xF9 on controllers
// that use them), 0xD7 for the index mark (0xFC) — so they can never occur
// inside ordinary data and reliably mark where a field starts. FM CRCs cover the
// mark byte and the field; there is no A1 preamble.
//
// `step` is the number of bit-cells per window: 1 when the stream runs at the FM
// cell rate, 2 when it was stored at the double-density rate (HxC, Greaseweazle
// and SCP flux recovered at the MFM cell time). With step 2 a window is read as
// a transition if either of its cells holds one, which tolerates the half-window
// jitter a flux PLL leaves.

const FM_MARK_CLOCK = 0xC7;

/** A transition anywhere in the window of `step` cells starting at `p`. */
function fmWindow(bytes: Uint8Array, p: number, nbits: number, step: number): number {
  for (let i = 0; i < step; i++) if (readBit(bytes, p + i, nbits)) return 1;
  return 0;
}

/** Data bits of the FM byte whose first (clock) window starts at `p`. */
function decodeFmByte(bytes: Uint8Array, p: number, nbits: number, step: number): number {
  let b = 0;
  for (let i = 0; i < 8; i++) b = (b << 1) | fmWindow(bytes, p + (2 * i + 1) * step, nbits, step);
  return b;
}

/**
 * The data byte of an FM address mark (clock 0xC7, data 0xF8-0xFE) whose first
 * clock transition is exactly at `p`, or -1. The first clock window must start
 * on its transition so the lock is cell-accurate (write-back relies on it).
 */
function fmMarkAt(bytes: Uint8Array, p: number, nbits: number, step: number): number {
  if (!readBit(bytes, p, nbits)) return -1;
  let data = 0;
  for (let i = 0; i < 8; i++) {
    const clock = fmWindow(bytes, p + 2 * i * step, nbits, step);
    if (clock !== ((FM_MARK_CLOCK >> (7 - i)) & 1)) return -1;
    const d = fmWindow(bytes, p + (2 * i + 1) * step, nbits, step);
    // Every data mark starts 11111: reject early.
    if (i < 5 && d === 0) return -1;
    data = (data << 1) | d;
  }
  return data >= 0xF8 && data <= 0xFE ? data : -1;
}

/** First FM address mark strictly within (from, limit), or -1. */
function findNextFmMark(bytes: Uint8Array, from: number, limit: number, nbits: number, step: number): number {
  for (let q = from + 1; q < limit; q++) if (fmMarkAt(bytes, q, nbits, step) >= 0) return q;
  return -1;
}

/** Decode one side's FM bit-cell stream (circular, `nbits` cells long). */
function decodeFmTrack(cells: Uint8Array, nbits: number, step: number, layoutOut?: HfeSectorLayout[]): DskTrack | null {
  const sectors: DskSector[] = [];
  const sectorMap = new Map<number, number>();
  const byteCells = 16 * step;
  let pending: { c: number; h: number; r: number; n: number } | null = null;

  let p = 0;
  while (p < nbits || (pending !== null && p < nbits + WRAP_SEARCH_BYTES * byteCells)) {
    const mark = fmMarkAt(cells, p, nbits, step);
    if (mark < 0) { p++; continue; }
    const body = p + byteCells;

    if (mark === 0xFE) {
      if (p >= nbits) break;
      const c = decodeFmByte(cells, body, nbits, step);
      const h = decodeFmByte(cells, body + byteCells, nbits, step);
      const r = decodeFmByte(cells, body + 2 * byteCells, nbits, step);
      const n = decodeFmByte(cells, body + 3 * byteCells, nbits, step);
      const crcStored = (decodeFmByte(cells, body + 4 * byteCells, nbits, step) << 8)
        | decodeFmByte(cells, body + 5 * byteCells, nbits, step);
      if (crc16([0xFE, c, h, r, n]) === crcStored) pending = { c, h, r, n };
      p = body + 6 * byteCells;
      continue;
    }

    if (mark >= 0xF8 && mark <= 0xFB) {
      if (!pending) { p = body; continue; }
      const declared = Math.min(128 << (pending.n & 0x0F), MAX_SECTOR_BYTES);
      const next = findNextFmMark(cells, body, body + (declared + 2) * byteCells, nbits, step);
      const truncated = next >= 0;
      const size = truncated ? Math.min(declared, Math.floor((next - body) / byteCells)) : declared;
      const payload = new Uint8Array(size);
      for (let i = 0; i < size; i++) payload[i] = decodeFmByte(cells, body + i * byteCells, nbits, step);
      const crcAt = body + size * byteCells;
      const dataBad = truncated || crc16([mark, ...payload]) !==
        ((decodeFmByte(cells, crcAt, nbits, step) << 8) | decodeFmByte(cells, crcAt + byteCells, nbits, step));

      const { st1, st2 } = fieldStatus(dataBad, mark);
      const sector: DskSector = { c: pending.c, h: pending.h, r: pending.r, n: pending.n, st1, st2, data: payload };
      const idx = sectors.push(sector) - 1;
      layoutOut?.push({ dataBit: body, len: size, mark, fm: step });
      if (!sectorMap.has(sector.r)) sectorMap.set(sector.r, idx);

      pending = null;
      p = truncated ? next : body + (size + 2) * byteCells;
      continue;
    }

    // Any other mark: step past it and keep scanning.
    p = body;
  }

  if (sectors.length === 0) return null;
  return { sectors, sectorMap, gap3: 0x10, filler: 0xE5, encoding: 'fm' };
}

/**
 * Decode one side's bit-cell stream into a DskTrack, or null if nothing
 * decodable (unformatted / empty) was found. The stream is treated as a
 * circular track of `nbits` cells (default: every cell in `cells`), matching
 * hardware and HxC's own reader. MFM is tried first; a track with no MFM
 * sector is then read as FM, at the double-density cell rate and then at the
 * FM cell rate. The result's `encoding` says which one it was.
 */
export function decodeHfeTrack(
  cells: Uint8Array, layoutOut?: HfeSectorLayout[], nbits = cells.length * 8,
): DskTrack | null {
  if (nbits < 64) return null;
  const mfm = decodeMfmTrack(cells, nbits, layoutOut);
  if (mfm) return mfm;
  for (const step of [2, 1]) {
    const fm = decodeFmTrack(cells, nbits, step, layoutOut);
    if (fm) return fm;
  }
  return null;
}

// ── HFE v3 opcode stream ─────────────────────────────────────────────────────
//
// HFE v3 keeps the v1 layout but lets a track byte be an opcode. Because the
// track bytes are bit-cells (LSB first), an opcode is a byte whose first four
// cells are all 1 — four adjacent flux transitions, which neither MFM nor FM
// stored at the double-density rate can produce. HxC defines the opcodes as
// 0xF0-0xF4 in its MSB-first view of the track, so in the file they appear
// bit-reversed (0x0F, 0x8F, 0x4F, 0xCF, 0x2F), as Greaseweazle writes them; the
// unreversed values are accepted too. Operand bytes are bit-reversed the same
// way.
//
//   NOP         no cells
//   SETINDEX    the index pulse is here (the track's start)
//   SETBITRATE  +1 byte: new bit rate from here on (no cells; cells are decoded
//               by count, so a rate change needs no handling)
//   SKIPBITS    +1 byte N (1-7), +1 data byte: only the last 8-N cells of the
//               data byte are on the track
//   RAND        8 cells of noise — weak bits, different on every read

const OP_NOP = 0;
const OP_SETINDEX = 1;
const OP_SETBITRATE = 2;
const OP_SKIPBITS = 3;
const OP_RAND = 4;

function rev8(b: number): number {
  b = ((b & 0xF0) >> 4) | ((b & 0x0F) << 4);
  b = ((b & 0xCC) >> 2) | ((b & 0x33) << 2);
  return ((b & 0xAA) >> 1) | ((b & 0x55) << 1);
}

/** The v3 opcode a track byte holds, or -1 for an ordinary cell byte. */
function hfeV3Opcode(b: number): number {
  if ((b & 0x0F) === 0x0F) {
    const op = rev8(b) & 0x0F;
    if (op <= OP_RAND) return op;
  }
  if ((b & 0xF0) === 0xF0 && (b & 0x0F) <= OP_RAND) return b & 0x0F;
  return -1;
}

/** An expanded v3 track: plain cells, their exact count, and whether any RAND
 *  (weak) bytes were filled in. */
export interface ExpandedHfeTrack { cells: Uint8Array; nbits: number; random: boolean }

/**
 * Expand one side of a v3 track into a plain bit-cell stream, starting at the
 * SETINDEX position. RAND bytes are filled from a small PRNG seeded with
 * `seed`, so each seed is one possible revolution.
 */
export function expandHfeV3(raw: Uint8Array, seed = 1): ExpandedHfeTrack {
  const out = new Uint8Array(raw.length);   // no opcode emits more cells than its bytes hold
  let nbits = 0;
  let index = -1;
  let random = false;
  let rng = Math.imul(seed, 0x9E3779B1) >>> 0 || 1;
  const put = (byte: number, from: number): void => {
    for (let i = from; i < 8; i++, nbits++) {
      if ((byte >> i) & 1) out[nbits >> 3] |= 1 << (nbits & 7);
    }
  };
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    switch (hfeV3Opcode(b)) {
      case -1: put(b, 0); break;
      case OP_NOP: break;
      case OP_SETINDEX: if (index < 0) index = nbits; break;
      case OP_SETBITRATE: i++; break;
      case OP_SKIPBITS: {
        const operand = raw[i + 1] ?? 0;
        const skip = operand <= 7 ? operand : rev8(operand) & 7;
        put(raw[i + 2] ?? 0, skip);
        i += 2;
        break;
      }
      case OP_RAND:
        rng ^= rng << 13; rng >>>= 0;
        rng ^= rng >>> 17;
        rng ^= rng << 5; rng >>>= 0;
        put(rng & 0xFF, 0);
        random = true;
        break;
    }
  }
  const cells = out.slice(0, (nbits + 7) >> 3);
  if (index <= 0 || index >= nbits) return { cells, nbits, random };
  // Rotate so the stream starts at the index, as v1 tracks do.
  const rotated = new Uint8Array(cells.length);
  for (let k = 0; k < nbits; k++) {
    const src = (k + index) % nbits;
    if ((cells[src >> 3] >> (src & 7)) & 1) rotated[k >> 3] |= 1 << (k & 7);
  }
  return { cells: rotated, nbits, random };
}

/** Random fills a weak (RAND) v3 track is decoded with. */
const V3_REVOLUTIONS = 3;

// ── Main parser ──────────────────────────────────────────────────────────────

export function parseHFE(data: Uint8Array): DskImage {
  if (data.length < 512) throw new Error('HFE file too small');

  const sig = asciiAt(data, 0, 8);
  const v3 = sig === SIG_V3;
  if (!v3 && sig !== SIG_V1) throw new Error('Not a valid HFE file');

  const numTracks = data[9];
  const numSides = data[10];
  if (numTracks === 0 || numSides === 0) throw new Error('HFE has no tracks');
  if (numSides > 2) throw new Error(`HFE has ${numSides} sides (max 2)`);

  // Track lookup table: `numTracks` entries of {offset(u16, 512-blocks), len(u16)}.
  const lutBase = u16LE(data, 18) * 512;

  const cells: (Uint8Array | null)[][] = [];
  const layout: (HfeSectorLayout[] | null)[][] = [];
  const tracks: (DskTrack | null)[][] = [];
  for (let t = 0; t < numTracks; t++) {
    const lut = lutBase + t * 4;
    const cellRow: (Uint8Array | null)[] = new Array(numSides).fill(null);
    const layoutRow: (HfeSectorLayout[] | null)[] = new Array(numSides).fill(null);
    const trackRow: (DskTrack | null)[] = new Array(numSides).fill(null);
    if (lut + 4 <= data.length) {
      const blockOffset = u16LE(data, lut) * 512;
      const trackLen = u16LE(data, lut + 2);
      if (trackLen > 0 && blockOffset < data.length) {
        for (let s = 0; s < numSides; s++) {
          const raw = extractSide(data, blockOffset, trackLen, s);
          const sideLayout: HfeSectorLayout[] = [];
          if (v3) {
            const first = expandHfeV3(raw, 1);
            cellRow[s] = first.cells;
            let track = decodeHfeTrack(first.cells, sideLayout, first.nbits);
            if (track && first.random) {
              // Weak bits: read the track again with other random fills and
              // keep every reading of a sector that changes.
              const revs: DskTrack[] = [track];
              for (let seed = 2; seed <= V3_REVOLUTIONS; seed++) {
                const e = expandHfeV3(raw, seed);
                const d = decodeHfeTrack(e.cells, undefined, e.nbits);
                if (d) revs.push(d);
              }
              track = mergeRevolutions(revs);
            }
            trackRow[s] = track;
          } else {
            cellRow[s] = raw;
            trackRow[s] = decodeHfeTrack(raw, sideLayout);
          }
          layoutRow[s] = trackRow[s] ? sideLayout : null;
        }
      }
    }
    cells.push(cellRow);
    layout.push(layoutRow);
    tracks.push(trackRow);
  }

  const bitstream: HfeBitstream = { cells, layout };
  const image: DskImage = {
    format: 'extended',
    numTracks,
    numSides,
    tracks,
    bitstream,
    diskFormat: '',
    protection: '',
  };

  image.diskFormat = detectDiskFormat(image);
  image.protection = detectProtection(image);
  image.flippy = isFlippyDisk(image);
  return image;
}

/**
 * Parse a floppy image for the uPD765A path (+3 / CPC), choosing the loader by
 * content: an HFE bitstream if the signature matches, otherwise a DSK. Callers
 * on the shared uPD765A route through this so `.hfe` and `.dsk` — and either
 * inside a ZIP — are both accepted wherever a disk is mounted.
 */
export function parseFloppyImage(data: Uint8Array): DskImage {
  if (isHFE(data)) return parseHFE(data);
  if (isScp(data)) return parseSCP(data);
  if (isTd0(data)) return parseTd0(data);
  return parseDSK(data);
}

// ── Write-back (serialize a mutated HFE-sourced image to HFE bytes) ────────────

function setBit(cells: Uint8Array, bit: number, val: number, nbits: number): void {
  const b = ((bit % nbits) + nbits) % nbits;
  const m = 1 << (b & 7);
  if (val) cells[b >> 3] |= m; else cells[b >> 3] &= ~m;
}

/** One byte of the field at `L`, `i` bytes in (FM or MFM, as the field was). */
function fieldByte(cells: Uint8Array, L: HfeSectorLayout, i: number, nbits: number): number {
  return L.fm
    ? decodeFmByte(cells, L.dataBit + i * 16 * L.fm, nbits, L.fm)
    : decodeByte(cells, L.dataBit + i * 16, nbits);
}

/** True if the data field at `L` already holds exactly `cur` (so no re-encode is
 *  needed — this preserves protected/unwritten fields, incl. bad CRC, verbatim). */
function fieldMatches(cells: Uint8Array, L: HfeSectorLayout, cur: Uint8Array, nbits: number): boolean {
  if (cur.length !== L.len) return false;
  for (let i = 0; i < L.len; i++) {
    if (fieldByte(cells, L, i, nbits) !== cur[i]) return false;
  }
  return true;
}

/**
 * Re-encode a data field (payload + CRC) in place over its original cells. The
 * clock of the first bit follows from the mark's last data cell, and the region
 * length ((len+2)×16 cells) is unchanged, so surrounding gaps/marks stay intact.
 * When `mark` differs from the field's recorded mark (a write that changed the
 * sector between normal and deleted data), the mark byte is rewritten too.
 */
function patchField(cells: Uint8Array, L: HfeSectorLayout, cur: Uint8Array, nbits: number, mark = L.mark): void {
  if (L.fm) { patchFmField(cells, L, cur, nbits, mark, L.fm); return; }
  const bytes = new Uint8Array(L.len);
  for (let i = 0; i < L.len; i++) bytes[i] = i < cur.length ? cur[i] : 0;
  const crc = crc16([0xA1, 0xA1, 0xA1, mark, ...bytes]);

  const rewriteMark = mark !== L.mark;
  // Start at the mark byte (after the A1 sync's last data cell) or at the data.
  let pos = rewriteMark ? L.dataBit - 16 : L.dataBit;
  let prev = readBit(cells, pos - 1, nbits);
  const writeByte = (v: number): void => {
    for (let i = 7; i >= 0; i--) {
      const d = (v >> i) & 1;
      const clock = (prev === 0 && d === 0) ? 1 : 0;
      setBit(cells, pos, clock, nbits);
      setBit(cells, pos + 1, d, nbits);
      pos += 2;
      prev = d;
    }
  };
  if (rewriteMark) writeByte(mark);
  for (const b of bytes) writeByte(b);
  writeByte(crc >> 8);
  writeByte(crc & 0xFF);
}

/** The FM counterpart of {@link patchField}: every clock window carries a
 *  transition (0xC7 for a rewritten mark), each window `step` cells wide with
 *  its transition in the first cell, as the field was locked on. */
function patchFmField(
  cells: Uint8Array, L: HfeSectorLayout, cur: Uint8Array, nbits: number, mark: number, step: number,
): void {
  const bytes = new Uint8Array(L.len);
  for (let i = 0; i < L.len; i++) bytes[i] = i < cur.length ? cur[i] : 0;
  const crc = crc16([mark, ...bytes]);
  const rewriteMark = mark !== L.mark;
  let pos = rewriteMark ? L.dataBit - 16 * step : L.dataBit;
  const windowAt = (pulse: number): void => {
    setBit(cells, pos, pulse, nbits);
    for (let i = 1; i < step; i++) setBit(cells, pos + i, 0, nbits);
    pos += step;
  };
  const writeByte = (v: number, clock = 0xFF): void => {
    for (let i = 7; i >= 0; i--) {
      windowAt((clock >> i) & 1);
      windowAt((v >> i) & 1);
    }
  };
  if (rewriteMark) writeByte(mark, FM_MARK_CLOCK);
  for (const b of bytes) writeByte(b);
  writeByte(crc >> 8);
  writeByte(crc & 0xFF);
}

/** The data mark a sector's field should carry: its recorded mark while the
 *  sector keeps the same kind (normal or deleted), else the standard one. */
function markFor(sector: DskSector, recorded: number): number {
  const deleted = (sector.st2 & 0x40) !== 0;
  if (deleted === isDeletedMark(recorded)) return recorded;
  return deleted ? 0xF8 : 0xFB;
}

/** True if the sector IDs decoded from a side's cells are exactly the ones the
 *  image's track now holds, in order — i.e. nothing has re-formatted it. */
function sameIdLayout(decoded: DskTrack | null, track: DskTrack): boolean {
  if (!decoded || decoded.sectors.length !== track.sectors.length) return false;
  // Re-formatted in the other density: the old cells no longer describe it.
  if (track.encoding !== undefined && track.encoding !== decoded.encoding) return false;
  for (let i = 0; i < track.sectors.length; i++) {
    const a = decoded.sectors[i], b = track.sectors[i];
    if (a.c !== b.c || a.h !== b.h || a.r !== b.r || a.n !== b.n) return false;
  }
  return true;
}

/** Assemble an HFE v1 image from per-track side cell streams (side 0 / side 1
 *  interleaved in 256-byte blocks; single-sided images carry an empty side 1,
 *  matching real HFEs). */
function packHFE(sides: (Uint8Array | null)[][], numTracks: number, numSides: number): Uint8Array {
  const header = new Uint8Array(512).fill(0xFF);
  for (let i = 0; i < 8; i++) header[i] = SIG_V1.charCodeAt(i);
  header[8] = 0;              // revision
  header[9] = numTracks;
  header[10] = numSides;
  header[11] = 0xFF;          // track encoding: unknown (ISO MFM), as greaseweazle writes
  header[12] = 250 & 0xFF; header[13] = 250 >> 8; // bit rate (kbit/s)
  header[18] = 1; header[19] = 0; // track list at block 1 (0x200)

  const lut = new Uint8Array(512);
  const blocks: Uint8Array[] = [];
  let blockCursor = 2; // header @ block 0, LUT @ block 1
  for (let t = 0; t < numTracks; t++) {
    const s0 = sides[t]?.[0] ?? new Uint8Array(256);
    const s1 = (numSides > 1 ? sides[t]?.[1] : null) ?? new Uint8Array(s0.length);
    // Interleave in whole 256-byte block pairs (side 0 then side 1), padding a
    // short final block with zeros — so track length is always a 512 multiple.
    const nBlocks = Math.ceil(Math.max(s0.length, s1.length) / 256);
    const interleaved = new Uint8Array(nBlocks * 512);
    for (let bi = 0; bi < nBlocks; bi++) {
      const off = bi * 256;
      interleaved.set(s0.subarray(off, off + 256), bi * 512);
      interleaved.set(s1.subarray(off, off + 256), bi * 512 + 256);
    }
    const e = t * 4;
    lut[e] = blockCursor & 0xFF; lut[e + 1] = blockCursor >> 8;
    lut[e + 2] = interleaved.length & 0xFF; lut[e + 3] = interleaved.length >> 8;
    const padded = new Uint8Array(Math.ceil(interleaved.length / 512) * 512);
    padded.set(interleaved);
    blocks.push(padded);
    blockCursor += padded.length / 512;
  }

  const parts = [header, lut, ...blocks];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

/**
 * Serialize an HFE-sourced {@link DskImage} back to HFE v1 bytes. Only sectors
 * whose data (or data mark) actually changed (a write) are re-encoded into a
 * copy of the retained bitstream; every unwritten field — including protection
 * tracks with odd gaps, non-standard marks or deliberately bad CRCs — is
 * preserved verbatim.
 *
 * A track whose sector IDs no longer match its retained cells has been
 * re-formatted in the emulator (new IDs, sizes or sector count), or is a
 * cylinder/side the image didn't originally have. Patching data fields into
 * the old layout would lose the format, so such a track is encoded afresh (FM
 * or MFM, as the track says) from its sectors (gaps, syncs, marks and CRCs), as
 * the controller would have laid it down.
 *
 * Throws if the image has no retained bitstream (i.e. it wasn't loaded from HFE).
 */
export function serializeHFE(image: DskImage): Uint8Array {
  const bs = image.bitstream;
  if (!bs) throw new Error('serializeHFE: image has no HFE bitstream (not HFE-sourced)');

  const { numTracks, numSides } = image;
  const patched: (Uint8Array | null)[][] = [];
  for (let t = 0; t < numTracks; t++) {
    const row: (Uint8Array | null)[] = new Array(numSides).fill(null);
    for (let s = 0; s < numSides; s++) {
      const cells = bs.cells[t]?.[s] ?? null;
      const track = image.tracks[t]?.[s] ?? null;
      const layout: HfeSectorLayout[] = [];
      const decoded = cells ? decodeHfeTrack(cells, layout) : null;
      if (track && track.sectors.length > 0 && !sameIdLayout(decoded, track)) {
        row[s] = encodeHfeTrack(track)?.cells ?? null;
        continue;
      }
      if (!cells) continue;
      const out = new Uint8Array(cells);          // patch a copy, leave the mount intact
      const nbits = out.length * 8;
      if (track && decoded) {
        for (let i = 0; i < track.sectors.length; i++) {
          const want = track.sectors[i];
          const cur = want.data;
          const wantMark = markFor(want, layout[i].mark);
          // A field on disk with a bad CRC that the image now holds as good
          // (the sector was rewritten with identical bytes) still needs the
          // fresh CRC laid down.
          const crcFixed = (decoded.sectors[i].st2 & 0x20) !== 0 && (want.st2 & 0x20) === 0;
          if (!fieldMatches(out, layout[i], cur, nbits) || wantMark !== layout[i].mark || crcFixed) {
            patchField(out, layout[i], cur, nbits, wantMark);
          }
        }
      }
      row[s] = out;
    }
    patched.push(row);
  }
  return packHFE(patched, numTracks, numSides);
}

// ── From-scratch encode (create a brand-new blank HFE) ─────────────────────────
//
// The write-back above only *patches* fields into cells that already exist, so it
// needs a disk that came from an HFE. To let the UI create a blank .hfe we build
// the bit-cell stream ourselves — the standard IBM System 34 double-density MFM
// track layout that a real +3/CPC/PCW controller lays down when it FORMATs a
// track. Each sector gets its sync/IDAM/gap/DAM/data/CRC run; the decoder above
// reads it straight back, and serializeHFE then patches later writes into it.

/** MFM cell for the C2 index-mark sync (a C2 byte with a missing clock). */
const MFM_SYNC_C2 = 0x5224;

/** Standard double-density gap/sync run lengths (bytes), per the System 34 track
 *  format. gap3 (inter-sector) comes from the disk format, not this table. */
const GAP4A = 80;    // post-index gap of 0x4E
const SYNC = 12;     // 0x00 sync run before an address mark
const GAP1 = 50;     // 0x4E after the index mark
const GAP2 = 22;     // 0x4E between the ID field and its data field

/** Target cell bytes per side for a 250 kbit/s DD track at 300 rpm — one full
 *  revolution is ~100 000 cells; matching a whole 256-byte block keeps the
 *  interleave in packHFE clean. Real greaseweazle dumps sit right around here. */
const TRACK_CELL_BYTES = 49 * 256; // 12544

/** Accumulates MFM bit-cells (clock,data pairs), tracking the previous data cell
 *  so each byte's leading clock follows the standard MFM rule (a clock is present
 *  only between two 0 data bits) — the same convention patchField writes with. */
class CellWriter {
  private bits: number[] = [];
  private prevData = 0;

  /** Current bit position — where the next cell will be written. */
  get pos(): number { return this.bits.length; }

  /** Emit a raw 16-cell pattern (an address-mark sync with its missing clock),
   *  most-significant cell first, matching cells16's read order. */
  raw16(v: number): void {
    for (let i = 15; i >= 0; i--) this.bits.push((v >> i) & 1);
    this.prevData = v & 1; // last cell is a data cell — seeds the next clock
  }

  /** MFM-encode one data byte: eight clock,data cell pairs, MSB first. */
  byte(v: number): void {
    for (let i = 7; i >= 0; i--) {
      const d = (v >> i) & 1;
      this.bits.push(this.prevData === 0 && d === 0 ? 1 : 0); // clock
      this.bits.push(d);                                      // data
      this.prevData = d;
    }
  }

  /** Emit `n` copies of the same byte (gap/sync runs). */
  fill(v: number, n: number): void { for (let i = 0; i < n; i++) this.byte(v); }

  /** Pad with 0x4E gap bytes up to `targetBits`, then zero-pad to a byte
   *  boundary, and pack LSB-first into a Uint8Array (the readBit convention). */
  finish(targetBits: number): Uint8Array {
    while (this.bits.length + 16 <= targetBits) this.byte(0x4E);
    while (this.bits.length < targetBits) this.bits.push(0);
    const out = new Uint8Array(this.bits.length >> 3);
    for (let i = 0; i < this.bits.length; i++) {
      if (this.bits[i]) out[i >> 3] |= 1 << (i & 7);
    }
    return out;
  }
}

/**
 * MFM-encode one decoded {@link DskTrack} into an HFE cell stream, recording each
 * sector's data-field position so later writes can be spliced back (parallel to
 * `track.sectors`, exactly as decodeHfeTrack produces). Returns null for an empty
 * track (an unformatted side).
 */
export function encodeHfeTrack(track: DskTrack): { cells: Uint8Array; layout: HfeSectorLayout[] } | null {
  if (track.sectors.length === 0) return null;
  if (track.encoding === 'fm') return encodeFmTrack(track);
  const w = new CellWriter();
  const layout: HfeSectorLayout[] = [];

  // Track lead-in: gap 4a, then the C2 index address mark, then gap 1.
  w.fill(0x4E, GAP4A);
  w.fill(0x00, SYNC);
  for (let i = 0; i < 3; i++) w.raw16(MFM_SYNC_C2);
  w.byte(0xFC);
  w.fill(0x4E, GAP1);

  for (const sec of track.sectors) {
    // ID address field: sync, 3×A1, IDAM, C H R N, CRC.
    w.fill(0x00, SYNC);
    for (let i = 0; i < 3; i++) w.raw16(MFM_SYNC_A1);
    w.byte(0xFE);
    w.byte(sec.c); w.byte(sec.h); w.byte(sec.r); w.byte(sec.n);
    const idCrc = crc16([0xA1, 0xA1, 0xA1, 0xFE, sec.c, sec.h, sec.r, sec.n]);
    w.byte(idCrc >> 8); w.byte(idCrc & 0xFF);

    // Data address field: gap 2, sync, 3×A1, DAM, payload, CRC.
    w.fill(0x4E, GAP2);
    w.fill(0x00, SYNC);
    for (let i = 0; i < 3; i++) w.raw16(MFM_SYNC_A1);
    // The sector's own mark (deleted data for ST2 CM) and CRC health (a
    // deliberately bad CRC for ST2 DD) carry over; a blank disk has neither.
    const mark = (sec.st2 & 0x40) ? 0xF8 : 0xFB;
    w.byte(mark);
    const dataBit = w.pos;
    for (const b of sec.data) w.byte(b);
    let dataCrc = crc16([0xA1, 0xA1, 0xA1, mark, ...sec.data]);
    if (sec.st2 & 0x20) dataCrc ^= 0xFFFF;
    w.byte(dataCrc >> 8); w.byte(dataCrc & 0xFF);
    layout.push({ dataBit, len: sec.data.length, mark });

    w.fill(0x4E, track.gap3); // gap 3 to the next sector
  }

  // One revolution: at least the content, rounded up to a whole 256-byte block.
  const minBits = Math.ceil(w.pos / (256 * 8)) * (256 * 8);
  const targetBits = Math.max(minBits, TRACK_CELL_BYTES * 8);
  return { cells: w.finish(targetBits), layout };
}

// ── From-scratch FM encode (IBM 3740 single density) ─────────────────────────
//
// FM tracks are laid out like MFM ones but with FM's shorter runs and no A1
// preamble: gap 4a of FF, six 00 sync bytes, the FC index mark (clock D7),
// gap 1, then per sector six 00 / FE ID mark (clock C7) / CHRN / CRC / gap 2 /
// six 00 / FB or F8 data mark (clock C7) / data / CRC / gap 3. A single-density
// revolution holds 3125 bytes (125 kbit/s at 300 rpm), so gap 3 is shrunk when
// the sectors would not otherwise fit, as a formatter sizes it. Cells are
// written at the double-density rate (two cells per window), which is how HxC
// and Greaseweazle store FM in an HFE.

const FM_SYNC = 6;
const FM_GAP4A = 40;
const FM_GAP1 = 26;
const FM_GAP2 = 11;
const FM_TRACK_BYTES = 3125;
const FM_INDEX_CLOCK = 0xD7;
/** Cells per FM window in the encoded stream. */
const FM_STEP = 2;

class FmCellWriter {
  private bits: number[] = [];
  constructor(private readonly step: number) {}
  get pos(): number { return this.bits.length; }
  private window(pulse: number): void {
    this.bits.push(pulse);
    for (let i = 1; i < this.step; i++) this.bits.push(0);
  }
  byte(v: number, clock = 0xFF): void {
    for (let i = 7; i >= 0; i--) {
      this.window((clock >> i) & 1);
      this.window((v >> i) & 1);
    }
  }
  fill(v: number, n: number): void { for (let i = 0; i < n; i++) this.byte(v); }
  finish(targetBits: number): Uint8Array {
    while (this.bits.length + 16 * this.step <= targetBits) this.byte(0xFF);
    while (this.bits.length < targetBits) this.bits.push(0);
    const out = new Uint8Array(this.bits.length >> 3);
    for (let i = 0; i < this.bits.length; i++) if (this.bits[i]) out[i >> 3] |= 1 << (i & 7);
    return out;
  }
}

function encodeFmTrack(track: DskTrack, step = FM_STEP): { cells: Uint8Array; layout: HfeSectorLayout[] } {
  const w = new FmCellWriter(step);
  const layout: HfeSectorLayout[] = [];
  const lead = FM_GAP4A + FM_SYNC + 1 + FM_GAP1;
  const fields = track.sectors.reduce((n, s) => n + FM_SYNC + 1 + 4 + 2 + FM_GAP2 + FM_SYNC + 1 + s.data.length + 2, 0);
  const room = Math.floor((FM_TRACK_BYTES - lead - fields) / track.sectors.length);
  const gap3 = Math.max(1, Math.min(track.gap3, room));

  w.fill(0xFF, FM_GAP4A);
  w.fill(0x00, FM_SYNC);
  w.byte(0xFC, FM_INDEX_CLOCK);
  w.fill(0xFF, FM_GAP1);
  for (const sec of track.sectors) {
    w.fill(0x00, FM_SYNC);
    w.byte(0xFE, FM_MARK_CLOCK);
    w.byte(sec.c); w.byte(sec.h); w.byte(sec.r); w.byte(sec.n);
    const idCrc = crc16([0xFE, sec.c, sec.h, sec.r, sec.n]);
    w.byte(idCrc >> 8); w.byte(idCrc & 0xFF);
    w.fill(0xFF, FM_GAP2);
    w.fill(0x00, FM_SYNC);
    const mark = (sec.st2 & 0x40) ? 0xF8 : 0xFB;
    w.byte(mark, FM_MARK_CLOCK);
    const dataBit = w.pos;
    for (const b of sec.data) w.byte(b);
    let dataCrc = crc16([mark, ...sec.data]);
    if (sec.st2 & 0x20) dataCrc ^= 0xFFFF;
    w.byte(dataCrc >> 8); w.byte(dataCrc & 0xFF);
    layout.push({ dataBit, len: sec.data.length, mark, fm: step });
    w.fill(0xFF, gap3);
  }
  const blockBits = 256 * 8;
  const revolution = FM_TRACK_BYTES * 16 * step;
  const targetBits = Math.ceil(Math.max(w.pos, revolution) / blockBits) * blockBits;
  return { cells: w.finish(targetBits), layout };
}

/**
 * Encode a whole sector-level image as a fresh HFE v1 file, each track in its
 * own density (FM or MFM; MFM when the image does not say). Sector oddities the
 * model carries — deleted-data marks, bad data CRCs, odd sizes, duplicate IDs —
 * are laid down as they are. Weak sectors keep their first reading.
 */
export function encodeHFE(image: DskImage): Uint8Array {
  return serializeHFE({ ...image, bitstream: { cells: [], layout: [] } });
}

/**
 * Attach a freshly-encoded HFE bitstream to a sector-level {@link DskImage} (from
 * createBlankDisk), turning it into an HFE-sourced disk that saveDisk/savePlusDDisk
 * will write back as `.hfe`. The decoded tracks are left untouched — the FDC keeps
 * driving off them — and the layout is generated in the same sector order, so
 * serializeHFE can patch writes back correctly.
 */
export function attachHfeBitstream(image: DskImage): DskImage {
  const cells: (Uint8Array | null)[][] = [];
  const layout: (HfeSectorLayout[] | null)[][] = [];
  for (let t = 0; t < image.numTracks; t++) {
    const cellRow: (Uint8Array | null)[] = new Array(image.numSides).fill(null);
    const layoutRow: (HfeSectorLayout[] | null)[] = new Array(image.numSides).fill(null);
    for (let s = 0; s < image.numSides; s++) {
      const track = image.tracks[t]?.[s];
      const enc = track ? encodeHfeTrack(track) : null;
      if (enc) { cellRow[s] = enc.cells; layoutRow[s] = enc.layout; }
    }
    cells.push(cellRow);
    layout.push(layoutRow);
  }
  image.format = 'extended';
  image.bitstream = { cells, layout };
  return image;
}

/** Create a brand-new blank disk of the given format as an HFE-sourced image, so
 *  it round-trips (and saves) as `.hfe` rather than `.dsk`. */
export function createBlankHfe(fmt: DiskFormat): DskImage {
  return attachHfeBitstream(createBlankDisk(fmt));
}
