import { describe, it, expect } from 'vitest';
import { parseMgt, serializeMgt, blankMgtDisk, isMgtSize, mgtExtFromName } from '@/floppy/mgt-image.ts';

const SECTOR = 512;
const SPT = 10;
const TRACKS = 80;
const SIDES = 2;
const SIZE_800K = TRACKS * SIDES * SPT * SECTOR; // 819200

// Independent (spec-derived) offset formulas for the two orderings, NOT taken
// from the implementation.
function mgtOffset(c: number, h: number, r: number): number {
  // cylinder-major, sides interleaved: C0/H0, C0/H1, C1/H0 …
  return ((c * SIDES + h) * SPT + (r - 1)) * SECTOR;
}
function imgOffset(c: number, h: number, r: number): number {
  // side-major: all of head 0 (C0..C79), then all of head 1
  return ((h * TRACKS + c) * SPT + (r - 1)) * SECTOR;
}

/** A unique, position-dependent tag so we can prove each sector lands at the
 *  right offset and that the two orderings really differ. */
function tag(c: number, h: number, r: number): number {
  return (c * 31 + h * 7 + r) & 0xFF;
}

function buildRaw(offsetFn: (c: number, h: number, r: number) => number): Uint8Array {
  const raw = new Uint8Array(SIZE_800K);
  for (let c = 0; c < TRACKS; c++)
    for (let h = 0; h < SIDES; h++)
      for (let r = 1; r <= SPT; r++)
        raw[offsetFn(c, h, r)] = tag(c, h, r); // first byte of the sector
  return raw;
}

describe('parseMgt geometry', () => {
  it('detects an 800K disk as 80×2×10', () => {
    const img = parseMgt(new Uint8Array(SIZE_800K), 'mgt')!;
    expect(img).not.toBeNull();
    expect(img.numTracks).toBe(80);
    expect(img.numSides).toBe(2);
    expect(img.tracks[0][0]!.sectors.length).toBe(10);
    expect(img.tracks[0][0]!.sectors[0].n).toBe(2); // 128<<2 = 512
  });

  it('detects a 720K disk as 80×2×9', () => {
    const img = parseMgt(new Uint8Array(80 * 2 * 9 * 512), 'img')!;
    expect(img.numTracks).toBe(80);
    expect(img.numSides).toBe(2);
    expect(img.tracks[0][0]!.sectors.length).toBe(9);
  });

  it('rejects an unrecognised size', () => {
    expect(parseMgt(new Uint8Array(12345), 'mgt')).toBeNull();
  });

  it('isMgtSize recognises 800K and rejects junk', () => {
    expect(isMgtSize(SIZE_800K)).toBe(true);
    expect(isMgtSize(1000)).toBe(false);
  });
});

describe('parseMgt ordering', () => {
  it('reads .mgt (cylinder-major, sides interleaved) from the right offsets', () => {
    const img = parseMgt(buildRaw(mgtOffset), 'mgt')!;
    for (const [c, h, r] of [[0, 0, 1], [0, 1, 1], [1, 0, 1], [5, 1, 10], [79, 1, 10]] as const) {
      expect(img.tracks[c][h]!.sectors[r - 1].data[0]).toBe(tag(c, h, r));
    }
  });

  it('reads .img (side-major) from the right offsets', () => {
    const img = parseMgt(buildRaw(imgOffset), 'img')!;
    for (const [c, h, r] of [[0, 0, 1], [0, 1, 1], [1, 0, 1], [5, 1, 10], [79, 1, 10]] as const) {
      expect(img.tracks[c][h]!.sectors[r - 1].data[0]).toBe(tag(c, h, r));
    }
  });

  it('.mgt and .img layouts genuinely differ for the same logical disk', () => {
    // Parse a tagged .mgt, then serialize the SAME image both ways; the two
    // byte streams must differ (proving the ordering matters), while each
    // round-trips its own ordering exactly.
    const raw = buildRaw(mgtOffset);
    const img = parseMgt(raw, 'mgt')!;
    const asMgt = serializeMgt(img, 'mgt');
    const asImg = serializeMgt(img, 'img');
    expect(Array.from(asMgt)).toEqual(Array.from(raw)); // round-trips its own order
    expect(Array.from(asImg)).not.toEqual(Array.from(asMgt));
    // And the .img output places C1/H0/R1 where the side-major formula says.
    expect(asImg[imgOffset(1, 0, 1)]).toBe(tag(1, 0, 1));
  });
});

describe('serializeMgt round-trip', () => {
  it('preserves all bytes through parse → serialize for both extensions', () => {
    const raw = new Uint8Array(SIZE_800K);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24 & 0xFF;
    for (const ext of ['mgt', 'img'] as const) {
      const back = serializeMgt(parseMgt(raw, ext)!, ext);
      expect(back.length).toBe(raw.length);
      expect(Array.from(back)).toEqual(Array.from(raw));
    }
  });
});

describe('blankMgtDisk', () => {
  it('is an 800K disk with every sector present and filled with 0xE5', () => {
    const img = blankMgtDisk();
    expect(img.numTracks).toBe(80);
    expect(img.numSides).toBe(2);
    expect(img.tracks[0][0]!.sectors.length).toBe(10);
    const sec = img.tracks[40][1]!.sectors[4].data;
    expect(sec.length).toBe(512);
    expect(sec.every(b => b === 0xE5)).toBe(true);
  });

  it('serializes to the expected 800K size', () => {
    expect(serializeMgt(blankMgtDisk(), 'mgt').length).toBe(SIZE_800K);
  });

  it('builds the smaller geometries with the right size and sidedness', () => {
    // 10 sectors × 512 B = 5120 B/track. Capacity = tracks × sides × 5120.
    const cases: [number, number, number][] = [
      [40, 2, 40 * 2 * 5120],   // 400K DS/40T
      [80, 1, 80 * 1 * 5120],   // 400K SS/80T
      [40, 1, 40 * 1 * 5120],   // 200K SS/40T
    ];
    for (const [tracks, sides, bytes] of cases) {
      const img = blankMgtDisk(tracks, sides);
      expect(img.numTracks).toBe(tracks);
      expect(img.numSides).toBe(sides);
      expect(img.tracks[tracks - 1][sides - 1]!.sectors.length).toBe(10);
      expect(serializeMgt(img, 'mgt').length).toBe(bytes);
    }
  });
});

describe('mgtExtFromName', () => {
  it('maps .img to img and everything else to mgt', () => {
    expect(mgtExtFromName('GAME.IMG')).toBe('img');
    expect(mgtExtFromName('game.mgt')).toBe('mgt');
    expect(mgtExtFromName('game')).toBe('mgt');
  });
});
