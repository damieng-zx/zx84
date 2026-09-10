/**
 * The Camputers Lynx .ldf raw sector dump.
 *
 * A headerless dump of 512-byte sectors, 10 a track, in cylinder-major,
 * head-minor order (MAME's `camplynx_dsk.cpp`): 200K is 40 tracks × 1 side,
 * 800K is 80 tracks × 2 sides.
 */

import { describe, expect, it } from 'vitest';
import {
  blankLdfDisk, isLdfSize, parseLdf, serializeLdf,
} from '@/media/floppy/ldf-image.ts';

const SPT = 10;
const SB = 512;

/** A dump whose every sector starts with its own c/h/r so mapping is visible. */
function makeLdf(tracks: number, sides: number): Uint8Array {
  const out = new Uint8Array(tracks * sides * SPT * SB);
  for (let c = 0; c < tracks; c++) {
    for (let h = 0; h < sides; h++) {
      const base = (c * sides + h) * SPT * SB;
      for (let s = 0; s < SPT; s++) {
        out[base + s * SB] = c;
        out[base + s * SB + 1] = h;
        out[base + s * SB + 2] = s + 1;
      }
    }
  }
  return out;
}

describe('Lynx .ldf geometry', () => {
  it('recognises the two documented sizes', () => {
    expect(isLdfSize(204800)).toBe(true);   // 200K SS/40T
    expect(isLdfSize(819200)).toBe(true);   // 800K DS/80T
  });

  it('rejects anything else', () => {
    expect(isLdfSize(0)).toBe(false);
    expect(isLdfSize(737280)).toBe(false);  // a +D size, not a Lynx one
    expect(isLdfSize(204799)).toBe(false);
    expect(parseLdf(new Uint8Array(12345))).toBeNull();
  });

  it('parses a 200K single-sided dump', () => {
    const img = parseLdf(makeLdf(40, 1))!;
    expect(img.numTracks).toBe(40);
    expect(img.numSides).toBe(1);
    const t0 = img.tracks[0][0]!;
    expect(t0.sectors.map(s => s.r)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Size code N=2 means 512-byte sectors.
    expect(t0.sectors.every(s => s.n === 2 && s.data.length === SB)).toBe(true);
  });

  it('orders a double-sided dump cylinder-major with heads interleaved', () => {
    const img = parseLdf(makeLdf(80, 2))!;
    // Track block 1 is C0/H1, not C1/H0.
    expect(img.tracks[0][1]!.sectors[0].c).toBe(0);
    expect(img.tracks[0][1]!.sectors[0].h).toBe(1);
    expect(img.tracks[1][0]!.sectors[0].c).toBe(1);
    expect(img.tracks[1][0]!.sectors[0].h).toBe(0);
    // And the raw bytes land where the mapping says they should.
    const s = img.tracks[0][1]!.sectors[0];
    expect([s.data[0], s.data[1], s.data[2]]).toEqual([0, 1, 1]);
  });

  it('round-trips a dump byte for byte', () => {
    for (const [tracks, sides] of [[40, 1], [80, 2]] as const) {
      const data = makeLdf(tracks, sides);
      expect(serializeLdf(parseLdf(data)!)).toEqual(data);
    }
  });

  it('builds a blank 800K disk with the 0xE5 filler', () => {
    const img = blankLdfDisk();
    expect(img.numTracks).toBe(80);
    expect(img.numSides).toBe(2);
    expect(img.diskFormat).toBe('Lynx LDF');
    expect(img.tracks[0][0]!.sectors[0].data[0]).toBe(0xE5);
    expect(serializeLdf(img).length).toBe(819200);
  });
});
