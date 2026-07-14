/**
 * HFE (HxC Floppy Emulator) disk image support — native bitstream track model.
 *
 * HFE is a *track-level* format: it stores the raw MFM bit-cell stream for every
 * track/side, exactly as the floppy read head sees it, rather than decoded
 * sectors. zx84's FDC cores drive off the sector-level {@link DskTrack}, so this
 * loader keeps the HFE bitstream as the disk's identity (attached to the
 * returned image as {@link HfeBitstream}) and decodes each track's MFM stream
 * into a DskTrack the way real hardware does — hunting A1 address-mark syncs,
 * reading the ID field (CHRN + CRC) and the following data field (honouring
 * deleted-data marks, CRC errors, odd sector sizes and track wrap-around). No
 * DSK file is produced and the DSK code path is never involved; the mounted
 * disk *is* the HFE.
 *
 * Scope (phase 1): HFE v1 ("HXCPICFE"), ISO/IBM double-density MFM — which
 * covers standard and protected +3 and CPC disks (validated byte-for-byte
 * against HxC's own hxcfe HFE→DSK conversion). HFE v3 ("HXCHFEV3", opcode
 * stream) is detected and rejected with a clear message. An HFE holds a single
 * deterministic revolution, so genuinely *randomised* weak-sector reads (some
 * Speedlock variants) are not representable here — those need the flux (.scp)
 * path, a separate job.
 *
 * Format reference: the HxC "HFE (HxC Floppy Emulator) file format" spec.
 */

import { parseDSK, type DskImage, type DskSector, type DskTrack, type HfeBitstream, type HfeSectorLayout } from './dsk.ts';
import { detectDiskFormat, detectProtection, isFlippyDisk } from './disk-detect.ts';

// ── Signatures ───────────────────────────────────────────────────────────────

const SIG_V1 = 'HXCPICFE';   // classic HFE (v1)
const SIG_V3 = 'HXCHFEV3';   // HFE v3 — opcode stream, not decoded here

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
 * CRC-16-CCITT (poly 0x1021, init 0xFFFF, MSB-first) as used for MFM address
 * and data field CRCs. Fed the address-mark bytes (A1 A1 A1) plus the field
 * body, the result is compared against the field's own stored 16-bit CRC.
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
 * Decode one side's MFM bit-cell stream into a DskTrack, or null if nothing
 * decodable (unformatted / FM / empty) was found. The stream is treated as a
 * circular track, matching hardware and HxC's own reader.
 */
export function decodeHfeTrack(cells: Uint8Array, layoutOut?: HfeSectorLayout[]): DskTrack | null {
  const nbits = cells.length * 8;
  if (nbits < 64) return null;

  const sectors: DskSector[] = [];
  const sectorMap = new Map<number, number>();

  // Pending ID address field awaiting its matching data field.
  let pending: { c: number; h: number; r: number; n: number } | null = null;

  // Scan one full revolution for address-mark syncs.
  let p = 0;
  while (p < nbits) {
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

      let st1 = 0;
      let st2 = 0;
      if (dataBad) { st1 |= 0x20; st2 |= 0x20; }    // ST1 DE + ST2 DD — bad data CRC
      if (mark === 0xF8) st2 |= 0x40;               // ST2 CM — deleted-data mark

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
  return { sectors, sectorMap, gap3: 0x52, filler: 0xE5 };
}

// ── Main parser ──────────────────────────────────────────────────────────────

export function parseHFE(data: Uint8Array): DskImage {
  if (data.length < 512) throw new Error('HFE file too small');

  const sig = asciiAt(data, 0, 8);
  if (sig === SIG_V3) {
    throw new Error('HFE v3 images are not yet supported (only v1 "HXCPICFE")');
  }
  if (sig !== SIG_V1) throw new Error('Not a valid HFE file');

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
          const sideCells = extractSide(data, blockOffset, trackLen, s);
          const sideLayout: HfeSectorLayout[] = [];
          cellRow[s] = sideCells;
          trackRow[s] = decodeHfeTrack(sideCells, sideLayout);
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
  return isHFE(data) ? parseHFE(data) : parseDSK(data);
}

// ── Write-back (serialize a mutated HFE-sourced image to HFE bytes) ────────────

function setBit(cells: Uint8Array, bit: number, val: number, nbits: number): void {
  const b = ((bit % nbits) + nbits) % nbits;
  const m = 1 << (b & 7);
  if (val) cells[b >> 3] |= m; else cells[b >> 3] &= ~m;
}

/** True if the data field at `L` already holds exactly `cur` (so no re-encode is
 *  needed — this preserves protected/unwritten fields, incl. bad CRC, verbatim). */
function fieldMatches(cells: Uint8Array, L: HfeSectorLayout, cur: Uint8Array, nbits: number): boolean {
  if (cur.length !== L.len) return false;
  for (let i = 0; i < L.len; i++) {
    if (decodeByte(cells, L.dataBit + i * 16, nbits) !== cur[i]) return false;
  }
  return true;
}

/**
 * Re-encode a data field (payload + CRC) in place over its original cells. The
 * clock of the first bit follows from the mark's last data cell, and the region
 * length ((len+2)×16 cells) is unchanged, so surrounding gaps/marks stay intact.
 */
function patchField(cells: Uint8Array, L: HfeSectorLayout, cur: Uint8Array, nbits: number): void {
  const bytes = new Uint8Array(L.len);
  for (let i = 0; i < L.len; i++) bytes[i] = i < cur.length ? cur[i] : 0;
  const crc = crc16([0xA1, 0xA1, 0xA1, L.mark, ...bytes]);

  let prev = readBit(cells, L.dataBit - 1, nbits); // last data cell of the mark byte
  let pos = L.dataBit;
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
  for (const b of bytes) writeByte(b);
  writeByte(crc >> 8);
  writeByte(crc & 0xFF);
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
 * whose data actually changed (a write) are re-encoded into a copy of the
 * retained bitstream; every unwritten field — including protection tracks with
 * odd gaps, non-standard marks or deliberately bad CRCs — is preserved verbatim.
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
      const cells = bs.cells[t]?.[s];
      if (!cells) continue;
      const out = new Uint8Array(cells);          // patch a copy, leave the mount intact
      const nbits = out.length * 8;
      const layout = bs.layout[t]?.[s];
      const track = image.tracks[t]?.[s];
      if (layout && track) {
        const count = Math.min(layout.length, track.sectors.length);
        for (let i = 0; i < count; i++) {
          const cur = track.sectors[i].data;
          if (!fieldMatches(out, layout[i], cur, nbits)) patchField(out, layout[i], cur, nbits);
        }
      }
      row[s] = out;
    }
    patched.push(row);
  }
  return packHFE(patched, numTracks, numSides);
}
