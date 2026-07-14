import { describe, it, expect } from 'vitest';
import { parseSCP, isScp } from '@/floppy/scp.ts';
import { encodeHfeTrack } from '@/floppy/hfe.ts';
import type { DskTrack, DskSector } from '@/floppy/disk-image.ts';

const CELL = 80; // 2µs bit-cell at 25ns/tick (DD MFM)

/** Build a one-track DskTrack with the given sectors (512-byte, +3-style). */
function track(sectors: { r: number; fill: number }[]): DskTrack {
  const s: DskSector[] = sectors.map(x => {
    const data = new Uint8Array(512); data.fill(x.fill);
    return { c: 0, h: 0, r: x.r, n: 2, st1: 0, st2: 0, data };
  });
  const map = new Map<number, number>(); s.forEach((sec, i) => map.set(sec.r, i));
  return { sectors: s, sectorMap: map, gap3: 0x52, filler: 0xE5 };
}

/** Invert the flux→cells decode: MFM cells → SCP flux intervals (in ticks). */
function cellsToFlux(cells: Uint8Array): number[] {
  const flux: number[] = [];
  let prev = -1;
  const nbits = cells.length * 8;
  for (let p = 0; p < nbits; p++) {
    if ((cells[p >> 3] >> (p & 7)) & 1) { flux.push((p - prev) * CELL); prev = p; }
  }
  return flux;
}

/** Assemble a minimal single-track SCP with the given per-revolution flux. */
function buildScp(revs: number[][]): Uint8Array {
  const numRevs = revs.length;
  const tdhStart = 0x10 + 168 * 4;                 // header + track-offset table
  const tdhHeader = 4 + numRevs * 12;              // "TRK"+num + per-rev triplets
  // Lay out flux blocks after the TDH.
  const fluxBlocks = revs.map(r => {
    const b = new Uint8Array(r.length * 2);
    for (let i = 0; i < r.length; i++) { b[i * 2] = (r[i] >> 8) & 0xFF; b[i * 2 + 1] = r[i] & 0xFF; }
    return b;
  });
  let off = tdhHeader;
  const dataOffsets = fluxBlocks.map(b => { const o = off; off += b.length; return o; });
  const total = tdhStart + off;
  const d = new Uint8Array(total);
  d[0] = 0x53; d[1] = 0x43; d[2] = 0x50;           // "SCP"
  d[5] = numRevs; d[6] = 0; d[7] = 0;              // revs, start/end track 0
  d[0x0A] = 1;                                      // heads = 1 (single-sided)
  d[0x0B] = 0;                                      // resolution = 25ns
  // Track 0 offset table entry → TDH.
  d[0x10] = tdhStart & 0xFF; d[0x11] = (tdhStart >> 8) & 0xFF;
  d[0x12] = (tdhStart >> 16) & 0xFF; d[0x13] = (tdhStart >> 24) & 0xFF;
  // TDH.
  d[tdhStart] = 0x54; d[tdhStart + 1] = 0x52; d[tdhStart + 2] = 0x4B; // "TRK"
  for (let r = 0; r < numRevs; r++) {
    const o = tdhStart + 4 + r * 12;
    // indexTime (arbitrary), fluxCount, dataOffset (relative to TDH).
    const fc = revs[r].length, doff = dataOffsets[r];
    d[o + 4] = fc & 0xFF; d[o + 5] = (fc >> 8) & 0xFF; d[o + 6] = (fc >> 16) & 0xFF;
    d[o + 8] = doff & 0xFF; d[o + 9] = (doff >> 8) & 0xFF; d[o + 10] = (doff >> 16) & 0xFF;
    d.set(fluxBlocks[r], tdhStart + doff);
  }
  return d;
}

function fluxFor(t: DskTrack): number[] {
  const enc = encodeHfeTrack(t);
  if (!enc) throw new Error('encode failed');
  return cellsToFlux(enc.cells);
}

describe('isScp', () => {
  it('recognises the SCP signature', () => {
    expect(isScp(Uint8Array.from([0x53, 0x43, 0x50, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(true);
    expect(isScp(new Uint8Array([1, 2, 3, 4]))).toBe(false);
  });
});

describe('parseSCP flux decode', () => {
  it('recovers sectors from a single-revolution flux track', () => {
    const t = track([{ r: 1, fill: 0xAA }, { r: 2, fill: 0xBB }]);
    const img = parseSCP(buildScp([fluxFor(t)]));
    // Format is detected from content (2 sectors × 512b here), with a "(flux)"
    // tag marking the flux origin — not a hardcoded "SCP (flux)" placeholder.
    expect(img.diskFormat).toBe('2×512b (flux)');
    const dec = img.tracks[0]![0]!;
    expect(dec.sectors.length).toBe(2);
    const s1 = dec.sectors[dec.sectorMap.get(1)!];
    const s2 = dec.sectors[dec.sectorMap.get(2)!];
    expect(s1.data.length).toBe(512);
    expect(s1.data.every(b => b === 0xAA)).toBe(true);
    expect(s2.data.every(b => b === 0xBB)).toBe(true);
    expect(s1.st1 & 0x20).toBe(0); // clean CRC — good read
  });
});

describe('parseSCP weak-sector detection across revolutions', () => {
  it('attaches copies[] for a sector that reads differently each revolution', () => {
    // Two revolutions: sector 1 differs (weak), sector 2 identical.
    const rev0 = fluxFor(track([{ r: 1, fill: 0x11 }, { r: 2, fill: 0x55 }]));
    const rev1 = fluxFor(track([{ r: 1, fill: 0x22 }, { r: 2, fill: 0x55 }]));
    const img = parseSCP(buildScp([rev0, rev1]));
    const dec = img.tracks[0]![0]!;

    const s1 = dec.sectors[dec.sectorMap.get(1)!];
    expect(s1.copies?.length).toBe(2);              // both readings kept
    expect(s1.st2 & 0x20).toBe(0x20);               // flagged weak
    const fills = s1.copies!.map(c => c[0]).sort();
    expect(fills).toEqual([0x11, 0x22]);

    const s2 = dec.sectors[dec.sectorMap.get(2)!];
    expect(s2.copies).toBeUndefined();              // identical across revs
    expect(s2.data.every(b => b === 0x55)).toBe(true);
  });
});
