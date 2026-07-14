import { describe, it, expect } from 'vitest';
import { parseHFE, serializeHFE, decodeHfeTrack, isHFE } from '@/plus3/hfe.ts';
import type { DskImage } from '@/plus3/dsk.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Independent HFE v1 / MFM *encoder*, derived from the HxC HFE spec and the IBM
// System 34 MFM spec — NOT from the parser under test. Each sector is written as
// a real MFM address-mark stream (sync field, A1 preamble with the 0x4489
// missing-clock pattern, IDAM/DAM, CRC-16-CCITT) so the tests exercise the
// decoder against a genuinely-encoded bitstream, with expectations worked out
// from the spec.
// ─────────────────────────────────────────────────────────────────────────────

/** CRC-16-CCITT (poly 0x1021, init 0xFFFF) — the MFM field CRC, from spec. */
function crc16(bytes: number[]): number {
  let c = 0xFFFF;
  for (const b of bytes) {
    c ^= (b & 0xFF) << 8;
    for (let i = 0; i < 8; i++) { c = (c & 0x8000) ? ((c << 1) ^ 0x1021) : (c << 1); c &= 0xFFFF; }
  }
  return c & 0xFFFF;
}

class MfmWriter {
  cells: number[] = [];
  private prev = 0; // previous data bit, for the MFM clock rule
  byte(b: number): void {
    for (let i = 7; i >= 0; i--) {
      const d = (b >> i) & 1;
      const clock = (this.prev === 0 && d === 0) ? 1 : 0;
      this.cells.push(clock, d);
      this.prev = d;
    }
  }
  bytes(arr: number[]): void { for (const b of arr) this.byte(b); }
  /** A1 sync: the literal 0x4489 missing-clock pattern (last data cell = 1). */
  a1(): void { const v = 0x4489; for (let i = 15; i >= 0; i--) this.cells.push((v >> i) & 1); this.prev = 1; }
  fill(n: number, b: number): void { for (let i = 0; i < n; i++) this.byte(b); }
}

interface SectorSpec {
  c: number; h: number; r: number; n: number;
  data: number[];
  mark?: number;       // 0xFB (default) or 0xF8 (deleted)
  a1?: number;         // number of A1 preamble marks (default 3)
  corruptData?: boolean;
}

/** Write one sector's IDAM + DAM. CRCs are always computed over three A1s, as a
 *  real writer does, even when fewer A1s are physically laid down. */
function writeSector(w: MfmWriter, s: SectorSpec): void {
  const mark = s.mark ?? 0xFB;
  const a1n = s.a1 ?? 3;
  // ID address field
  w.fill(12, 0x00);
  for (let i = 0; i < a1n; i++) w.a1();
  w.byte(0xFE);
  w.bytes([s.c, s.h, s.r, s.n]);
  const idc = crc16([0xA1, 0xA1, 0xA1, 0xFE, s.c, s.h, s.r, s.n]);
  w.byte(idc >> 8); w.byte(idc & 0xFF);
  w.fill(22, 0x4E); // gap 2
  // Data address field
  w.fill(12, 0x00);
  for (let i = 0; i < a1n; i++) w.a1();
  w.byte(mark);
  w.bytes(s.data);
  let dc = crc16([0xA1, 0xA1, 0xA1, mark, ...s.data]);
  if (s.corruptData) dc ^= 0xFFFF;
  w.byte(dc >> 8); w.byte(dc & 0xFF);
  w.fill(40, 0x4E); // gap 3
}

/** Pack a cell array (LSB-first per byte) and pad to a 256-byte boundary. */
function packSide(sectors: SectorSpec[]): Uint8Array {
  const w = new MfmWriter();
  w.fill(60, 0x4E); // gap 4a
  for (const s of sectors) writeSector(w, s);
  const nbytes = Math.ceil(w.cells.length / 8);
  const padded = Math.ceil(nbytes / 256) * 256;
  const out = new Uint8Array(padded);
  for (let i = 0; i < w.cells.length; i++) if (w.cells[i]) out[i >> 3] |= 1 << (i & 7);
  return out;
}

/** Assemble a full HFE v1 image from per-track side-0 bitstreams (single-sided:
 *  side-1 blocks are present but empty, exactly as real single-sided HFEs). */
function buildHFE(trackSides: Uint8Array[], numSides = 1): Uint8Array {
  const header = new Uint8Array(512).fill(0xFF);
  for (let i = 0; i < 8; i++) header[i] = 'HXCPICFE'.charCodeAt(i);
  header[8] = 0;                 // revision
  header[9] = trackSides.length; // tracks
  header[10] = numSides;         // sides
  header[11] = 0xFF;             // encoding: unknown (greaseweazle writes this)
  header[12] = 250 & 0xFF; header[13] = 250 >> 8;
  header[18] = 1; header[19] = 0; // track list at block 1 (0x200)

  // Interleave side 0 with an equal-length empty side 1 in 256-byte blocks.
  const blocks: Uint8Array[] = [];
  const lut = new Uint8Array(trackSides.length * 4);
  let blockCursor = 2; // first track data block (after header@0, LUT@1)
  trackSides.forEach((side0, t) => {
    const empty = new Uint8Array(side0.length);
    const interleaved = new Uint8Array(side0.length * 2);
    for (let off = 0; off < side0.length; off += 256) {
      interleaved.set(side0.subarray(off, off + 256), off * 2);
      interleaved.set(empty.subarray(off, off + 256), off * 2 + 256);
    }
    const off = t * 4;
    lut[off] = blockCursor & 0xFF; lut[off + 1] = blockCursor >> 8;
    lut[off + 2] = interleaved.length & 0xFF; lut[off + 3] = interleaved.length >> 8;
    blocks.push(interleaved);
    blockCursor += Math.ceil(interleaved.length / 512);
  });

  const lutBlock = new Uint8Array(512); lutBlock.set(lut);
  const parts = [header, lutBlock, ...blocks.map(b => { const p = new Uint8Array(Math.ceil(b.length / 512) * 512); p.set(b); return p; })];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0; for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('HFE signature detection', () => {
  it('recognises v1 and v3 signatures, rejects others', () => {
    const v1 = new Uint8Array(512); for (let i = 0; i < 8; i++) v1[i] = 'HXCPICFE'.charCodeAt(i);
    const v3 = new Uint8Array(512); for (let i = 0; i < 8; i++) v3[i] = 'HXCHFEV3'.charCodeAt(i);
    expect(isHFE(v1)).toBe(true);
    expect(isHFE(v3)).toBe(true);
    expect(isHFE(new Uint8Array([0x4D, 0x56, 0x20, 0x2D]))).toBe(false); // "MV -" DSK
  });

  it('parseHFE rejects a v3 image with a clear message', () => {
    const v3 = new Uint8Array(512); for (let i = 0; i < 8; i++) v3[i] = 'HXCHFEV3'.charCodeAt(i);
    v3[9] = 1; v3[10] = 1;
    expect(() => parseHFE(v3)).toThrow(/v3/i);
  });
});

describe('decodeHfeTrack — MFM sector recovery', () => {
  it('recovers two normal sectors with correct CHRN and data', () => {
    const dataA = Array.from({ length: 256 }, (_, i) => (i * 3) & 0xFF);
    const dataB = Array.from({ length: 256 }, (_, i) => (i ^ 0x5A) & 0xFF);
    const track = decodeHfeTrack(packSide([
      { c: 0, h: 0, r: 1, n: 1, data: dataA },
      { c: 0, h: 0, r: 2, n: 1, data: dataB },
    ]))!;
    expect(track.sectors.length).toBe(2);
    const s1 = track.sectors[track.sectorMap.get(1)!];
    expect([s1.c, s1.h, s1.r, s1.n]).toEqual([0, 0, 1, 1]);
    expect(s1.st1 | s1.st2).toBe(0);
    expect(Array.from(s1.data)).toEqual(dataA);
    expect(Array.from(track.sectors[track.sectorMap.get(2)!].data)).toEqual(dataB);
  });

  it('recovers a sector written with only two A1 sync marks', () => {
    // Worn/odd disks emit 2 A1s; the CRC is still over 3, so it reads clean.
    const data = Array.from({ length: 128 }, (_, i) => i & 0xFF);
    const track = decodeHfeTrack(packSide([
      { c: 4, h: 0, r: 1, n: 0, data },
      { c: 4, h: 0, r: 7, n: 0, data, a1: 2 },
    ]))!;
    expect(track.sectorMap.has(7)).toBe(true);
    const s7 = track.sectors[track.sectorMap.get(7)!];
    expect(s7.st1 | s7.st2).toBe(0);
    expect(Array.from(s7.data)).toEqual(data);
  });

  it('flags a deleted-data address mark with ST2 CM (0x40)', () => {
    const data = Array.from({ length: 128 }, () => 0xE5);
    const track = decodeHfeTrack(packSide([{ c: 0, h: 0, r: 1, n: 0, data, mark: 0xF8 }]))!;
    const s = track.sectors[0];
    expect(s.st2 & 0x40).toBe(0x40); // CM
    expect(Array.from(s.data)).toEqual(data); // data still recovered
  });

  it('flags a bad data-field CRC with ST1 DE + ST2 DD (0x20/0x20)', () => {
    const data = Array.from({ length: 128 }, (_, i) => (i + 1) & 0xFF);
    const track = decodeHfeTrack(packSide([{ c: 0, h: 0, r: 1, n: 0, data, corruptData: true }]))!;
    const s = track.sectors[0];
    expect(s.st1 & 0x20).toBe(0x20);
    expect(s.st2 & 0x20).toBe(0x20);
  });

  it('does not let a bogus giant-N sector swallow the following sector', () => {
    // R=193 declares N=6 (8192 bytes) but real data ends at the next sync — the
    // short-sector protection trick. The following R=1 must still be found.
    const giant = Array.from({ length: 40 }, () => 0xAA);
    const real = Array.from({ length: 512 }, (_, i) => i & 0xFF);
    const track = decodeHfeTrack(packSide([
      { c: 9, h: 0, r: 193, n: 6, data: giant },
      { c: 9, h: 0, r: 1, n: 2, data: real },
    ]))!;
    expect(track.sectorMap.has(193)).toBe(true);
    expect(track.sectorMap.has(1)).toBe(true);
    // The giant sector's data was truncated, so it reads as a data error…
    expect(track.sectors[track.sectorMap.get(193)!].st2 & 0x20).toBe(0x20);
    // …but the real sector after it is intact.
    const s1 = track.sectors[track.sectorMap.get(1)!];
    expect(s1.st1 | s1.st2).toBe(0);
    expect(Array.from(s1.data)).toEqual(real);
  });

  it('returns null for an unformatted (empty) track', () => {
    expect(decodeHfeTrack(new Uint8Array(1024))).toBeNull();
  });
});

describe('parseHFE — full image (header, LUT, side de-interleave)', () => {
  it('parses a single-sided two-track image through the interleaved layout', () => {
    const t0 = packSide([{ c: 0, h: 0, r: 1, n: 2, data: Array.from({ length: 512 }, (_, i) => i & 0xFF) }]);
    const t1 = packSide([{ c: 1, h: 0, r: 1, n: 2, data: Array.from({ length: 512 }, (_, i) => (i + 1) & 0xFF) }]);
    const img = parseHFE(buildHFE([t0, t1], 1));

    expect(img.numTracks).toBe(2);
    expect(img.numSides).toBe(1);
    expect(img.bitstream).toBeDefined();               // raw flux retained
    expect(img.bitstream!.cells[0][0]).toBeInstanceOf(Uint8Array);

    const cyl1 = img.tracks[1]![0]!;
    const s = cyl1.sectors[cyl1.sectorMap.get(1)!];
    expect(s.c).toBe(1);
    expect(Array.from(s.data.subarray(0, 4))).toEqual([1, 2, 3, 4]);
  });
});

describe('serializeHFE — write-back', () => {
  // A track mixing a normal sector, a deleted-data sector and a bad-CRC sector.
  const mkImage = (): DskImage => {
    const dataN = (n: number, seed: number) => Array.from({ length: 512 }, (_, i) => (i * seed + n) & 0xFF);
    const t0 = packSide([
      { c: 0, h: 0, r: 1, n: 2, data: dataN(1, 3) },
      { c: 0, h: 0, r: 2, n: 2, data: dataN(2, 5), mark: 0xF8 },        // deleted
      { c: 0, h: 0, r: 3, n: 2, data: dataN(3, 7), corruptData: true }, // bad CRC
    ]);
    return parseHFE(buildHFE([t0], 1));
  };

  const dump = (img: DskImage) => img.tracks[0]![0]!.sectors.map(s =>
    `r${s.r}/${s.st1.toString(16)}/${s.st2.toString(16)}/${Array.from(s.data).join(',')}`);

  it('round-trips an unwritten image byte-for-byte (protection preserved)', () => {
    const img = mkImage();
    const before = dump(img);
    const round = parseHFE(serializeHFE(img));
    expect(dump(round)).toEqual(before);
    // The deleted mark and bad-CRC flags survive the re-encode.
    expect(round.tracks[0]![0]!.sectors[1].st2 & 0x40).toBe(0x40);
    expect(round.tracks[0]![0]!.sectors[2].st1 & 0x20).toBe(0x20);
  });

  it('re-encodes a written sector and leaves the others untouched', () => {
    const img = mkImage();
    const track = img.tracks[0]![0]!;
    const original = dump(img);
    // Simulate the FDC's writeBackSector: replace sector r1's data.
    const newData = new Uint8Array(512).map((_, i) => (0xA0 ^ i) & 0xFF);
    track.sectors[track.sectorMap.get(1)!].data = newData;

    const round = parseHFE(serializeHFE(img));
    const rt = round.tracks[0]![0]!;

    const s1 = rt.sectors[rt.sectorMap.get(1)!];
    expect(s1.st1 | s1.st2).toBe(0);                          // freshly written → good CRC
    expect(Array.from(s1.data)).toEqual(Array.from(newData)); // read back exactly

    // r2 (deleted) and r3 (bad-CRC) are byte-identical to the original.
    expect(dump(round)[1]).toBe(original[1]);
    expect(dump(round)[2]).toBe(original[2]);
  });

  it('throws when the image has no retained HFE bitstream', () => {
    const notHfe = { numTracks: 1, numSides: 1, format: 'extended', tracks: [[null]], diskFormat: '', protection: '' } as unknown as DskImage;
    expect(() => serializeHFE(notHfe)).toThrow(/bitstream/i);
  });
});
