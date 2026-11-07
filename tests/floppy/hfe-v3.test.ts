import { describe, it, expect } from 'vitest';
import { expandHfeV3, parseHFE, serializeHFE } from '@/media/floppy/hfe.ts';

// ─────────────────────────────────────────────────────────────────────────────
// HFE v3, built from the HxC format description rather than from the parser:
//   * the header and track layout are v1's, with the signature "HXCHFEV3";
//   * track bytes are bit-cells sent LSB first, and a byte can instead be an
//     opcode — 0xF0 NOP, 0xF1 SETINDEX, 0xF2 SETBITRATE (+1 byte), 0xF3
//     SKIPBITS (+1 byte count, +1 data byte of which only the last 8-count
//     cells are sent), 0xF4 RAND (a byte of random cells) — written to the
//     file bit-reversed like every other byte of HxC's MSB-first track view,
//     as Greaseweazle writes them: 0x0F, 0x8F, 0x4F, 0xCF, 0x2F.
// Track cells are an independently written MFM (IBM System 34) stream.
// ─────────────────────────────────────────────────────────────────────────────

function rev8(b: number): number {
  let r = 0;
  for (let i = 0; i < 8; i++) if (b & (1 << i)) r |= 0x80 >> i;
  return r;
}

const NOP = rev8(0xF0), SETINDEX = rev8(0xF1), SETBITRATE = rev8(0xF2), SKIPBITS = rev8(0xF3), RAND = rev8(0xF4);

function crc16(bytes: number[]): number {
  let c = 0xFFFF;
  for (const b of bytes) {
    c ^= (b & 0xFF) << 8;
    for (let i = 0; i < 8; i++) { c = (c & 0x8000) ? ((c << 1) ^ 0x1021) : (c << 1); c &= 0xFFFF; }
  }
  return c;
}

/** MFM cells, one array entry per cell, in time order. */
class Mfm {
  cells: number[] = [];
  private prev = 0;
  byte(b: number): void {
    for (let i = 7; i >= 0; i--) {
      const d = (b >> i) & 1;
      this.cells.push(this.prev === 0 && d === 0 ? 1 : 0, d);
      this.prev = d;
    }
  }
  fill(n: number, b: number): void { for (let i = 0; i < n; i++) this.byte(b); }
  a1(): void { for (let i = 15; i >= 0; i--) this.cells.push((0x4489 >> i) & 1); this.prev = 1; }
  /** Cell index where the next byte starts. */
  get at(): number { return this.cells.length; }
}

const pattern = (len: number, seed: number): number[] => Array.from({ length: len }, (_, i) => (i * 5 + seed * 17) & 0xFF);

/** A track of three 256-byte sectors (R 1-3); returns the cells and the cell
 *  index each data field starts at. */
function mfmTrack(): { cells: number[]; dataAt: number[] } {
  const w = new Mfm();
  const dataAt: number[] = [];
  w.fill(60, 0x4E);
  for (let r = 1; r <= 3; r++) {
    w.fill(12, 0x00); w.a1(); w.a1(); w.a1(); w.byte(0xFE);
    const id = [0, 0, r, 1];
    id.forEach(b => w.byte(b));
    const idc = crc16([0xA1, 0xA1, 0xA1, 0xFE, ...id]);
    w.byte(idc >> 8); w.byte(idc & 0xFF);
    w.fill(22, 0x4E); w.fill(12, 0x00); w.a1(); w.a1(); w.a1(); w.byte(0xFB);
    dataAt.push(w.at);
    const data = pattern(256, r);
    data.forEach(b => w.byte(b));
    const dc = crc16([0xA1, 0xA1, 0xA1, 0xFB, ...data]);
    w.byte(dc >> 8); w.byte(dc & 0xFF);
    w.fill(40, 0x4E);
  }
  while (w.cells.length % 8) w.cells.push(0);
  return { cells: w.cells, dataAt };
}

/** Pack cells [from, to) into LSB-first bytes (to - from must be a multiple of 8). */
function bytesOf(cells: number[], from: number, to: number): number[] {
  const out: number[] = [];
  for (let p = from; p < to; p += 8) {
    let b = 0;
    for (let i = 0; i < 8; i++) if (cells[p + i]) b |= 1 << i;
    out.push(b);
  }
  return out;
}

/** A single-sided HFE file with the given raw side-0 track streams. */
function hfeFile(sig: string, tracks: number[][]): Uint8Array {
  const header = new Uint8Array(512).fill(0xFF);
  header.set([...sig].map(c => c.charCodeAt(0)));
  header[8] = 0; header[9] = tracks.length; header[10] = 1;
  header[18] = 1; header[19] = 0;
  const lut = new Uint8Array(512);
  const blocks: Uint8Array[] = [];
  let block = 2;
  tracks.forEach((side0, t) => {
    const n = Math.ceil(side0.length / 256);
    const data = new Uint8Array(n * 512);
    // Pad side 0 with NOPs (no cells) and leave side 1 blank.
    for (let i = 0; i < n * 256; i++) data[(i >> 8) * 512 + (i & 255)] = i < side0.length ? side0[i] : NOP;
    lut[t * 4] = block & 0xFF; lut[t * 4 + 1] = block >> 8;
    lut[t * 4 + 2] = data.length & 0xFF; lut[t * 4 + 3] = data.length >> 8;
    blocks.push(data);
    block += data.length / 512;
  });
  const out = new Uint8Array(1024 + blocks.reduce((n, b) => n + b.length, 0));
  out.set(header); out.set(lut, 512);
  let at = 1024;
  for (const b of blocks) { out.set(b, at); at += b.length; }
  return out;
}

const cellBits = (bytes: Uint8Array, n: number): number[] =>
  Array.from({ length: n }, (_, i) => (bytes[i >> 3] >> (i & 7)) & 1);

describe('expandHfeV3 — the opcode stream', () => {
  // Cell bytes chosen with no nibble of four set cells, as real FM/MFM data.
  const A = [0x12, 0x34];
  const B = [0x56, 0x78, 0x9A];
  const C = [0xBC, 0x2D];
  const bits = (bytes: number[]): number[] => bytes.flatMap(b => Array.from({ length: 8 }, (_, i) => (b >> i) & 1));

  it('drops NOP and SETBITRATE (with its operand) and starts the track at SETINDEX', () => {
    const raw = Uint8Array.from([...A, SETINDEX, ...B, NOP, SETBITRATE, rev8(72), ...C]);
    const e = expandHfeV3(raw);
    expect(e.nbits).toBe(8 * (A.length + B.length + C.length));
    expect(e.random).toBe(false);
    expect(cellBits(e.cells, e.nbits)).toEqual(bits([...B, ...C, ...A]));
  });

  it('SKIPBITS sends only the last 8-N cells of its data byte', () => {
    // N = 3: cells 3..7 of 0b10110_101 (the low three are junk) are 0,1,1,0,1.
    const raw = Uint8Array.from([0x12, SKIPBITS, rev8(3), 0b10110101, 0x34]);
    const e = expandHfeV3(raw);
    expect(e.nbits).toBe(8 + 5 + 8);
    expect(cellBits(e.cells, e.nbits)).toEqual([...bits([0x12]), 0, 1, 1, 0, 1, ...bits([0x34])]);
  });

  it('accepts the opcodes unreversed too (0xF0-0xF4)', () => {
    const raw = Uint8Array.from([...A, 0xF1, ...B, 0xF0, 0xF2, 72, 0xF3, 3, 0b10110101, ...C]);
    const e = expandHfeV3(raw);
    expect(cellBits(e.cells, e.nbits)).toEqual([...bits(B), 0, 1, 1, 0, 1, ...bits(C), ...bits(A)]);
  });

  it('RAND emits eight cells that change with the revolution', () => {
    const raw = Uint8Array.from([0x12, RAND, RAND, 0x34]);
    const a = expandHfeV3(raw, 1);
    const b = expandHfeV3(raw, 2);
    expect(a.nbits).toBe(32);
    expect(a.random).toBe(true);
    expect(a.cells[0]).toBe(0x12);
    expect(a.cells[3]).toBe(0x34);
    expect([a.cells[1], a.cells[2]]).not.toEqual([b.cells[1], b.cells[2]]);
  });
});

describe('parseHFE — HFE v3 images', () => {
  it('decodes a track with opcodes inside a sector\'s data field', () => {
    const { cells, dataAt } = mfmTrack();
    const d = dataAt[1];                       // sector 2's data field
    // Split the stream: whole bytes to 16 bytes into the field, then 5 cells by
    // SKIPBITS 3, then whole bytes again (shifted by those 5 cells).
    const cut = d + 16 * 8;
    const head = bytesOf(cells, 0, cut);
    let partial = 0;
    for (let i = 0; i < 5; i++) if (cells[cut + i]) partial |= 1 << (3 + i);
    partial |= 0b101;                          // junk in the skipped cells
    const rest = cells.slice(cut + 5);
    while (rest.length % 8) rest.push(0);
    const tail = bytesOf(rest, 0, rest.length);
    const stream = [
      SETINDEX, SETBITRATE, rev8(72),
      ...head.slice(0, 100), NOP, ...head.slice(100, head.length - 4), SETBITRATE, rev8(71), ...head.slice(head.length - 4),
      SKIPBITS, rev8(3), partial,
      ...tail,
    ];
    const img = parseHFE(hfeFile('HXCHFEV3', [stream]));
    const t = img.tracks[0][0]!;
    expect(t.sectors.map(s => s.r)).toEqual([1, 2, 3]);
    for (const s of t.sectors) {
      expect(s.st1 | s.st2).toBe(0);
      expect(Array.from(s.data)).toEqual(pattern(256, s.r));
    }
  });

  it('keeps sectors whole around RAND bytes in a gap', () => {
    const { cells, dataAt } = mfmTrack();
    const bytes = bytesOf(cells, 0, cells.length);
    const gap = (dataAt[0] >> 3) + 2 * (256 + 2) + 8;    // inside gap 3 after sector 1's data
    bytes.splice(gap, 2, RAND, RAND);
    const t = parseHFE(hfeFile('HXCHFEV3', [bytes])).tracks[0][0]!;
    expect(t.sectors.map(s => s.r)).toEqual([1, 2, 3]);
    expect(t.sectors.every(s => s.copies === undefined && (s.st1 | s.st2) === 0)).toBe(true);
  });

  it('makes a sector with RAND bytes in its data field weak, keeping every reading', () => {
    const { cells, dataAt } = mfmTrack();
    const bytes = bytesOf(cells, 0, cells.length);
    const at = (dataAt[2] >> 3) + 2 * 40;      // 40 data bytes into sector 3 (two cell bytes a data byte)
    bytes.splice(at, 4, RAND, RAND, RAND, RAND);
    const t = parseHFE(hfeFile('HXCHFEV3', [bytes])).tracks[0][0]!;
    const weak = t.sectors[t.sectorMap.get(3)!];
    expect(weak.st1).toBe(0x20);                 // the CRC no longer holds
    expect(weak.copies!.length).toBeGreaterThan(1);
    // The readings differ only in the two data bytes the RAND cells cover.
    const want = pattern(256, 3);
    for (const copy of weak.copies!) {
      for (let i = 0; i < 256; i++) if (i < 40 || i > 41) expect(copy[i]).toBe(want[i]);
    }
    const others = t.sectors.filter(s => s.r !== 3);
    expect(others.every(s => s.copies === undefined && (s.st1 | s.st2) === 0)).toBe(true);
  });

  it('saves a v3 image back as v1, with a written sector re-encoded', () => {
    const { cells } = mfmTrack();
    const img = parseHFE(hfeFile('HXCHFEV3', [[SETINDEX, ...bytesOf(cells, 0, cells.length)]]));
    img.tracks[0][0]!.sectors[0].data.fill(0x77);
    const saved = serializeHFE(img);
    expect(String.fromCharCode(...saved.subarray(0, 8))).toBe('HXCPICFE');
    const back = parseHFE(saved).tracks[0][0]!;
    expect(back.sectors[0].data.every(b => b === 0x77)).toBe(true);
    expect(Array.from(back.sectors[2].data)).toEqual(pattern(256, 3));
  });
});
