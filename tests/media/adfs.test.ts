/**
 * ADFS floppy images. An ADFS disc is 16 × 256-byte sectors per track, IDs 0-15
 * with no interleave. ADFS L (640K) is one volume whose logical sectors run
 * through side 0 and then side 1 — which the .adl file mirrors (checked against
 * a real disc by loading a file across the track boundary through the ADFS ROM).
 */

import { describe, it, expect } from 'vitest';
import {
  ADFS_TRACK_BYTES, blankAdfs, isAdfsLength, parseAdfs, serializeAdfs,
} from '@/media/floppy/adfs.ts';

/** A disc whose every byte records its logical sector number (low byte) so layout errors show. */
function labelled(sectors: number): Uint8Array {
  const d = new Uint8Array(sectors * 256);
  for (let s = 0; s < sectors; s++) d.fill(s & 0xFF, s * 256, (s + 1) * 256);
  return d;
}

describe('ADFS image geometry', () => {
  it.each([
    [160 * 1024, 40, 1],
    [320 * 1024, 80, 1],
    [640 * 1024, 80, 2],
  ])('treats a %i byte image as %i tracks, %i sides', (bytes, tracks, sides) => {
    const img = parseAdfs(new Uint8Array(bytes));
    expect(img.numTracks).toBe(tracks);
    expect(img.numSides).toBe(sides);
    expect(img.diskFormat).toBe('ADFS');
  });

  it('pads a truncated image up to its size class', () => {
    const img = parseAdfs(new Uint8Array(200 * 1024));           // more than an S disc: an M disc cut short
    expect(img.numTracks).toBe(80);
    expect(img.numSides).toBe(1);
    expect(img.tracks[79][0]!.sectors).toHaveLength(16);
  });

  it('keeps a trimmed .adl double-sided when told it is', () => {
    const img = parseAdfs(new Uint8Array(200 * 1024), true);
    expect(img.numSides).toBe(2);
    expect(img.tracks[79][1]!.sectors).toHaveLength(16);
  });

  it('rejects empty and oversized images', () => {
    expect(() => parseAdfs(new Uint8Array(0))).toThrow();
    expect(() => parseAdfs(new Uint8Array(700 * 1024))).toThrow();
  });

  it('only recognises whole-track lengths up to 640K', () => {
    expect(isAdfsLength(655360)).toBe(true);
    expect(isAdfsLength(655360 + 256)).toBe(false);
    expect(isAdfsLength(4000)).toBe(false);
    expect(isAdfsLength(0)).toBe(false);
  });
});

describe('ADFS sector layout', () => {
  it('numbers sectors 0-15 in physical order, 256 bytes each (size code 1)', () => {
    const t = parseAdfs(labelled(16 * 40)).tracks[0][0]!;
    expect(t.sectors.map(s => s.r)).toEqual([...Array(16).keys()]);
    expect(t.sectors.every(s => s.n === 1 && s.data.length === 256)).toBe(true);
    expect(t.sectorMap.get(9)).toBe(9);
    expect(t.sectors[0].c).toBe(0);
    expect(t.sectors[0].h).toBe(0);
  });

  it('single-sided images run track after track', () => {
    const img = parseAdfs(labelled(16 * 40));
    expect(img.tracks[3][0]!.sectors[5].data[0]).toBe(3 * 16 + 5);
  });

  it('double-sided images fill side 0 first, then side 1 (logical sector order)', () => {
    const img = parseAdfs(labelled(2560));
    // Logical sector 16 is the first sector of track 1 on side 0, not of side 1 track 0.
    expect(img.tracks[1][0]!.sectors[0].data[0]).toBe(16);
    expect(img.tracks[0][1]!.sectors[0].data[0]).toBe(1280 & 0xFF);
    expect(img.tracks[79][0]!.sectors[15].data[0]).toBe(1279 & 0xFF);
    expect(img.tracks[0][1]!.sectors[0].h).toBe(1);
  });
});

describe('ADFS serialisation', () => {
  it('round-trips an L image byte for byte', () => {
    const src = labelled(2560);
    expect(Array.from(serializeAdfs(parseAdfs(src)))).toEqual(Array.from(src));
  });

  it('writes sector changes back at their logical position', () => {
    const img = parseAdfs(labelled(2560));
    img.tracks[2][1]!.sectors[3].data.fill(0xAA);
    const out = serializeAdfs(img);
    expect(out[(1280 + 2 * 16 + 3) * 256]).toBe(0xAA);
    expect(out[(1280 + 2 * 16 + 4) * 256]).toBe((1280 + 2 * 16 + 4) & 0xFF);
  });

  it('builds blank discs of each class', () => {
    const l = blankAdfs(80, true);
    expect(serializeAdfs(l).length).toBe(640 * 1024);
    expect(serializeAdfs(blankAdfs(40, false)).length).toBe(40 * ADFS_TRACK_BYTES);
  });
});
