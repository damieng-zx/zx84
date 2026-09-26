/**
 * Acorn DFS floppy images: `.ssd` (single-sided) and `.dsd` (double-sided).
 *
 * These are raw sector dumps — no header — of 10 × 256-byte sectors per track.
 * `.dsd` interleaves the two sides per track (side 0 track 0, side 1 track 0,
 * side 0 track 1, …). They materialise into the shared `DskImage` model.
 */

import type { DskImage, DskSector, DskTrack } from './disk-image.ts';

export const SSD_SECTOR_SIZE = 256;
export const SSD_SECTORS_PER_TRACK = 10;
export const SSD_TRACK_BYTES = SSD_SECTOR_SIZE * SSD_SECTORS_PER_TRACK;
/** Unformatted-sector filler used by the DFS formatter. */
const FILLER = 0xE5;

export function isSsdLength(length: number): boolean {
  return length > 0 && length % SSD_TRACK_BYTES === 0 && length <= SSD_TRACK_BYTES * 160;
}

function buildTrack(data: Uint8Array, base: number, cyl: number, side: number): DskTrack {
  const sectors: DskSector[] = [];
  const sectorMap = new Map<number, number>();
  for (let r = 0; r < SSD_SECTORS_PER_TRACK; r++) {
    const off = base + r * SSD_SECTOR_SIZE;
    sectorMap.set(r, sectors.length);
    sectors.push({
      c: cyl, h: side, r, n: 1, st1: 0, st2: 0,
      data: data.slice(off, off + SSD_SECTOR_SIZE),
    });
  }
  return { sectors, sectorMap, gap3: 0x2A, filler: FILLER };
}

export function parseSsd(data: Uint8Array, doubleSided: boolean): DskImage {
  const totalTracks = Math.floor(data.length / SSD_TRACK_BYTES);
  if (totalTracks === 0) throw new Error('SSD image too small');
  const numSides = doubleSided ? 2 : 1;
  const numTracks = doubleSided ? Math.floor(totalTracks / 2) : totalTracks;
  const tracks: (DskTrack | null)[][] = [];
  for (let t = 0; t < numTracks; t++) {
    const sides: (DskTrack | null)[] = new Array(numSides).fill(null);
    for (let s = 0; s < numSides; s++) {
      const base = doubleSided ? (t * 2 + s) * SSD_TRACK_BYTES : t * SSD_TRACK_BYTES;
      sides[s] = buildTrack(data, base, t, s);
    }
    tracks.push(sides);
  }
  return {
    format: 'standard',
    numTracks,
    numSides,
    tracks,
    diskFormat: 'DFS',
    protection: '',
  };
}

export function serializeSsd(image: DskImage, doubleSided: boolean): Uint8Array {
  const numSides = doubleSided ? 2 : 1;
  const out = new Uint8Array(image.numTracks * numSides * SSD_TRACK_BYTES);
  out.fill(FILLER);
  for (let t = 0; t < image.numTracks; t++) {
    for (let s = 0; s < numSides; s++) {
      const track = image.tracks[t]?.[s];
      const base = doubleSided ? (t * 2 + s) * SSD_TRACK_BYTES : t * SSD_TRACK_BYTES;
      if (!track) continue;
      for (const sec of track.sectors) {
        if (sec.r < 0 || sec.r >= SSD_SECTORS_PER_TRACK) continue;
        out.set(sec.data.subarray(0, SSD_SECTOR_SIZE), base + sec.r * SSD_SECTOR_SIZE);
      }
    }
  }
  return out;
}
