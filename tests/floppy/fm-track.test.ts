import { describe, it, expect } from 'vitest';
import { decodeHfeTrack, encodeHFE, parseHFE, serializeHFE } from '@/media/floppy/hfe.ts';
import { parseSCP } from '@/media/floppy/scp.ts';
import { parseSsd, SSD_TRACK_BYTES } from '@/media/floppy/ssd.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Independent FM (IBM 3740 single density) encoder, written from the format
// definition and not from the decoder under test:
//   * every data bit is a clock window then a data window; ordinary bytes have
//     a transition in every clock window (clock 0xFF);
//   * address marks are bytes with clock 0xC7 — data 0xFE for an ID field,
//     0xFB for data, 0xF8 for deleted data — and the index mark is 0xFC with
//     clock 0xD7;
//   * the ID and data field CRCs are CRC-16-CCITT (poly 0x1021, preset 0xFFFF)
//     over the mark byte and the field, high byte first.
// `step` is the number of bit-cells per window: 1 at the FM cell rate, 2 when
// stored at the double-density rate as HxC and Greaseweazle store FM.
// ─────────────────────────────────────────────────────────────────────────────

function crc16(bytes: number[]): number {
  let c = 0xFFFF;
  for (const b of bytes) {
    c ^= (b & 0xFF) << 8;
    for (let i = 0; i < 8; i++) { c = (c & 0x8000) ? ((c << 1) ^ 0x1021) : (c << 1); c &= 0xFFFF; }
  }
  return c;
}

class FmWriter {
  cells: number[] = [];
  /** Data windows whose transition is laid in the window's second cell, as a
   *  flux PLL leaves jitter (only meaningful with step 2). */
  jitterEvery = 0;
  private windows = 0;
  constructor(private readonly step: number) {}
  private window(pulse: number, mayJitter: boolean): void {
    const late = mayJitter && this.step > 1 && this.jitterEvery > 0 && (++this.windows % this.jitterEvery) === 0;
    for (let i = 0; i < this.step; i++) this.cells.push(pulse && i === (late ? 1 : 0) ? 1 : 0);
  }
  byte(d: number, clock = 0xFF): void {
    for (let i = 7; i >= 0; i--) {
      this.window((clock >> i) & 1, false);
      this.window((d >> i) & 1, true);
    }
  }
  fill(n: number, d: number): void { for (let i = 0; i < n; i++) this.byte(d); }
}

interface FmSector {
  c: number; h: number; r: number; n: number;
  data: number[];
  mark?: number;
  badData?: boolean;
  badId?: boolean;
}

function writeSector(w: FmWriter, s: FmSector): void {
  w.fill(6, 0x00);
  w.byte(0xFE, 0xC7);
  w.byte(s.c); w.byte(s.h); w.byte(s.r); w.byte(s.n);
  let idc = crc16([0xFE, s.c, s.h, s.r, s.n]);
  if (s.badId) idc ^= 0x0101;
  w.byte(idc >> 8); w.byte(idc & 0xFF);
  w.fill(11, 0xFF);
  w.fill(6, 0x00);
  const mark = s.mark ?? 0xFB;
  w.byte(mark, 0xC7);
  for (const b of s.data) w.byte(b);
  let dc = crc16([mark, ...s.data]);
  if (s.badData) dc ^= 0xFFFF;
  w.byte(dc >> 8); w.byte(dc & 0xFF);
  w.fill(27, 0xFF);
}

/** One FM track (index mark, gaps, sectors), packed LSB-first like HFE cells. */
function fmCells(sectors: FmSector[], step: number, jitterEvery = 0): Uint8Array {
  const w = new FmWriter(step);
  w.jitterEvery = jitterEvery;
  w.fill(40, 0xFF);
  w.fill(6, 0x00);
  w.byte(0xFC, 0xD7);
  w.fill(26, 0xFF);
  for (const s of sectors) writeSector(w, s);
  w.fill(60, 0xFF);
  const out = new Uint8Array(Math.ceil(w.cells.length / 8 / 256) * 256);
  w.cells.forEach((v, i) => { if (v) out[i >> 3] |= 1 << (i & 7); });
  return out;
}

const pattern = (len: number, seed: number): number[] => Array.from({ length: len }, (_, i) => (i * 7 + seed) & 0xFF);
const sec = (r: number, extra: Partial<FmSector> = {}): FmSector =>
  ({ c: 0, h: 0, r, n: 1, data: pattern(256, r), ...extra });

/** A single-sided HFE v1 file with one side's cells per track. */
function hfeFile(tracks: Uint8Array[]): Uint8Array {
  const header = new Uint8Array(512).fill(0xFF);
  header.set([...'HXCPICFE'].map(c => c.charCodeAt(0)));
  header[8] = 0; header[9] = tracks.length; header[10] = 1;
  header[18] = 1; header[19] = 0;
  const lut = new Uint8Array(512);
  const blocks: Uint8Array[] = [];
  let block = 2;
  tracks.forEach((side0, t) => {
    const n = Math.ceil(side0.length / 256);
    const data = new Uint8Array(n * 512);
    for (let b = 0; b < n; b++) data.set(side0.subarray(b * 256, b * 256 + 256), b * 512);
    lut[t * 4] = block & 0xFF; lut[t * 4 + 1] = block >> 8;
    lut[t * 4 + 2] = data.length & 0xFF; lut[t * 4 + 3] = data.length >> 8;
    blocks.push(data);
    block += data.length / 512;
  });
  const total = 1024 + blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  out.set(header); out.set(lut, 512);
  let at = 1024;
  for (const b of blocks) { out.set(b, at); at += b.length; }
  return out;
}

describe('FM CRC (test oracle)', () => {
  it('is CRC-16/CCITT-FALSE: check value 0x29B1 for "123456789"', () => {
    expect(crc16([...'123456789'].map(c => c.charCodeAt(0)))).toBe(0x29B1);
  });
});

describe('decodeHfeTrack — FM (single density)', () => {
  it('reads FM sectors stored at the double-density rate (two cells a window)', () => {
    const t = decodeHfeTrack(fmCells([sec(0), sec(1)], 2))!;
    expect(t.encoding).toBe('fm');
    expect(t.sectors.map(s => [s.c, s.h, s.r, s.n])).toEqual([[0, 0, 0, 1], [0, 0, 1, 1]]);
    expect(Array.from(t.sectors[1].data)).toEqual(pattern(256, 1));
    expect(t.sectors.every(s => s.st1 === 0 && s.st2 === 0)).toBe(true);
  });

  it('reads FM at its own cell rate (one cell a window)', () => {
    const t = decodeHfeTrack(fmCells([sec(4), sec(5)], 1))!;
    expect(t.encoding).toBe('fm');
    expect(t.sectors.map(s => s.r)).toEqual([4, 5]);
    expect(Array.from(t.sectors[0].data)).toEqual(pattern(256, 4));
  });

  it('reads a window whose transition sits in its second cell (flux jitter)', () => {
    const t = decodeHfeTrack(fmCells([sec(0), sec(1)], 2, 3))!;
    expect(t.sectors.map(s => s.r)).toEqual([0, 1]);
    expect(t.sectors.every(s => s.st1 === 0 && s.st2 === 0)).toBe(true);
    expect(Array.from(t.sectors[1].data)).toEqual(pattern(256, 1));
  });

  it('flags a deleted-data mark (0xF8) with ST2 CM', () => {
    const t = decodeHfeTrack(fmCells([sec(0, { mark: 0xF8 }), sec(1)], 2))!;
    expect(t.sectors[0].st2).toBe(0x40);
    expect(t.sectors[1].st2).toBe(0);
  });

  it('flags a bad data CRC with ST1 DE + ST2 DD but still returns the data', () => {
    const t = decodeHfeTrack(fmCells([sec(0), sec(1, { badData: true })], 2))!;
    expect(t.sectors[1].st1).toBe(0x20);
    expect(t.sectors[1].st2).toBe(0x20);
    expect(Array.from(t.sectors[1].data)).toEqual(pattern(256, 1));
  });

  it('drops a sector whose ID field fails its CRC', () => {
    const t = decodeHfeTrack(fmCells([sec(0), sec(1, { badId: true }), sec(2)], 2))!;
    expect(t.sectors.map(s => s.r)).toEqual([0, 2]);
  });

  it('reads 128-byte (N=0) and 512-byte (N=2) sectors and odd IDs on one track', () => {
    const t = decodeHfeTrack(fmCells([
      { c: 39, h: 1, r: 0xF0, n: 0, data: pattern(128, 9) },
      { c: 0, h: 0, r: 7, n: 2, data: pattern(512, 3) },
    ], 2))!;
    expect(t.sectors.map(s => [s.c, s.h, s.r, s.n, s.data.length])).toEqual([[39, 1, 0xF0, 0, 128], [0, 0, 7, 2, 512]]);
    expect(Array.from(t.sectors[1].data)).toEqual(pattern(512, 3));
  });

  it('keeps duplicate IDs as separate sectors, the first being the one an ID lookup finds', () => {
    const t = decodeHfeTrack(fmCells([
      { ...sec(3), data: new Array(256).fill(0x11) },
      { ...sec(3), data: new Array(256).fill(0x22) },
    ], 2))!;
    expect(t.sectors.length).toBe(2);
    expect(t.sectors[t.sectorMap.get(3)!].data[0]).toBe(0x11);
    expect(t.sectors[1].data[0]).toBe(0x22);
  });

  it('finds nothing on an empty track', () => {
    expect(decodeHfeTrack(new Uint8Array(12544))).toBeNull();
  });
});

describe('FM in HFE images', () => {
  it('writes a changed FM sector back in place and leaves the others as they were', () => {
    const file = hfeFile([fmCells([sec(0), sec(1), sec(2, { badData: true, mark: 0xF8 })], 2)]);
    const img = parseHFE(file);
    const t = img.tracks[0][0]!;
    t.sectors[1].data.fill(0x5A);
    const back = parseHFE(serializeHFE(img)).tracks[0][0]!;
    expect(back.encoding).toBe('fm');
    expect(Array.from(back.sectors[0].data)).toEqual(pattern(256, 0));
    expect(back.sectors[1].data.every(b => b === 0x5A)).toBe(true);
    expect(back.sectors[1].st1 | back.sectors[1].st2).toBe(0);     // fresh good CRC
    // The protected sector was not written: its deleted mark and bad CRC stay.
    expect(back.sectors[2].st2).toBe(0x60);
    expect(Array.from(back.sectors[2].data)).toEqual(pattern(256, 2));
  });

  it('rewrites the data mark when a sector becomes deleted data', () => {
    const img = parseHFE(hfeFile([fmCells([sec(0), sec(1)], 2)]));
    img.tracks[0][0]!.sectors[0].st2 |= 0x40;
    const back = parseHFE(serializeHFE(img)).tracks[0][0]!;
    expect(back.sectors[0].st2).toBe(0x40);
    expect(Array.from(back.sectors[0].data)).toEqual(pattern(256, 0));
  });

  it('encodes a DFS sector image as FM HFE that reads back identically, one revolution a track', () => {
    const raw = new Uint8Array(SSD_TRACK_BYTES * 40);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 13 + (i >> 8)) & 0xFF;
    raw[0x106] = 400 >> 8; raw[0x107] = 400 & 0xFF;    // catalogue: a 400-sector (40-track) disc
    const ssd = parseSsd(raw, false);
    const hfe = parseHFE(encodeHFE(ssd));
    expect(hfe.numTracks).toBe(40);
    for (let t = 0; t < 40; t++) {
      const a = ssd.tracks[t][0]!, b = hfe.tracks[t][0]!;
      expect(b.encoding).toBe('fm');
      expect(b.sectors.map(s => [s.c, s.r, s.n])).toEqual(a.sectors.map(s => [s.c, s.r, s.n]));
      for (let i = 0; i < 10; i++) expect(b.sectors[i].data).toEqual(a.sectors[i].data);
    }
    // 125 kbit/s at 300 rpm is 3125 bytes = 100 000 cells at two cells a window:
    // 12 500 bytes, padded to whole 256-byte blocks.
    expect(hfe.bitstream!.cells[0][0]!.length).toBe(12544);
  });

  it('encodes deleted marks and bad CRCs into a fresh FM HFE', () => {
    const ssd = parseSsd(new Uint8Array(SSD_TRACK_BYTES * 2), false);
    ssd.tracks[0][0]!.sectors[3].st2 = 0x40;
    ssd.tracks[1][0]!.sectors[5].st1 = 0x20;
    ssd.tracks[1][0]!.sectors[5].st2 = 0x20;
    const hfe = parseHFE(encodeHFE(ssd));
    expect(hfe.tracks[0][0]!.sectors[3].st2).toBe(0x40);
    expect(hfe.tracks[1][0]!.sectors[5].st2).toBe(0x20);
    expect(hfe.tracks[1][0]!.sectors[4].st2).toBe(0);
  });
});

describe('FM in SCP flux images', () => {
  // 25 ns ticks; a 2 µs cell is 80 ticks, so an FM window (two cells) is 4 µs.
  const CELL = 80;
  function scpOf(cells: Uint8Array): Uint8Array {
    const flux: number[] = [];
    let prev = -1;
    for (let p = 0; p < cells.length * 8; p++) {
      if ((cells[p >> 3] >> (p & 7)) & 1) { flux.push((p - prev) * CELL); prev = p; }
    }
    const tdh = 0x10 + 168 * 4;
    const d = new Uint8Array(tdh + 16 + flux.length * 2);
    d.set([0x53, 0x43, 0x50]);
    d[5] = 1; d[0x0A] = 1;
    d[0x10] = tdh & 0xFF; d[0x11] = tdh >> 8;
    d.set([0x54, 0x52, 0x4B], tdh);
    d[tdh + 8] = flux.length & 0xFF; d[tdh + 9] = (flux.length >> 8) & 0xFF;
    d[tdh + 12] = 16;
    flux.forEach((v, i) => { d[tdh + 16 + i * 2] = v >> 8; d[tdh + 17 + i * 2] = v & 0xFF; });
    return d;
  }

  it('recovers FM sectors from flux at 4 µs a window', () => {
    const img = parseSCP(scpOf(fmCells([sec(0), sec(1, { mark: 0xF8 })], 2)));
    const t = img.tracks[0][0]!;
    expect(t.encoding).toBe('fm');
    expect(t.sectors.map(s => s.r)).toEqual([0, 1]);
    expect(t.sectors[1].st2).toBe(0x40);
    expect(Array.from(t.sectors[0].data)).toEqual(pattern(256, 0));
  });
});
