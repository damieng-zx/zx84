/**
 * Acorn ADFS floppy images: `.adf`, `.ads`, `.adm` and `.adl`.
 *
 * Raw sector dumps — no header — of 16 × 256-byte sectors per track (IDs 0-15,
 * no interleave), as the Plus 3's WD1770 and ADFS lay them down:
 *
 *   ADFS S   160K   40 tracks, one side
 *   ADFS M   320K   80 tracks, one side
 *   ADFS L   640K   80 tracks, two sides, one 2560-sector volume: logical
 *                   sectors 0-1279 fill side 0 track by track, then 1280-2559
 *                   side 1 (so the file is the disc in logical-sector order)
 *
 * They materialise into the shared `DskImage` model. Short files (images are
 * often trimmed after the last used sector) are padded with filler up to the
 * size class they belong to.
 */

import type { DskImage, DskSector, DskTrack } from './disk-image.ts';

export const ADFS_SECTOR_SIZE = 256;
export const ADFS_SECTORS_PER_TRACK = 16;
export const ADFS_TRACK_BYTES = ADFS_SECTOR_SIZE * ADFS_SECTORS_PER_TRACK;
const FILLER = 0xE5;

/** Image size by format class. */
const S_BYTES = 40 * ADFS_TRACK_BYTES;
const M_BYTES = 80 * ADFS_TRACK_BYTES;
const L_BYTES = 160 * ADFS_TRACK_BYTES;

export function isAdfsLength(length: number): boolean {
  return length > 0 && length % ADFS_TRACK_BYTES === 0 && length <= L_BYTES;
}

interface AdfsGeometry { tracks: 40 | 80; sides: 1 | 2 }

function geometryFor(length: number, doubleSided: boolean): AdfsGeometry {
  // A double-sided file may have been trimmed after the last used sector, which
  // a size alone can't tell from a smaller single-sided disc: `.adl` says so.
  if (doubleSided) return { tracks: 80, sides: 2 };
  if (length <= S_BYTES) return { tracks: 40, sides: 1 };
  if (length <= M_BYTES) return { tracks: 80, sides: 1 };
  return { tracks: 80, sides: 2 };
}

function buildTrack(data: Uint8Array, base: number, cyl: number, side: number): DskTrack {
  const sectors: DskSector[] = [];
  const sectorMap = new Map<number, number>();
  for (let r = 0; r < ADFS_SECTORS_PER_TRACK; r++) {
    const off = base + r * ADFS_SECTOR_SIZE;
    sectorMap.set(r, sectors.length);
    sectors.push({
      c: cyl, h: side, r, n: 1, st1: 0, st2: 0,
      data: data.slice(off, off + ADFS_SECTOR_SIZE),
    });
  }
  return { sectors, sectorMap, gap3: 0x1B, filler: FILLER };
}

/** Offset of a track in the file: sides are laid end to end, not interleaved
 *  as DFS `.dsd` images are. */
function trackOffset(track: number, side: number, tracksPerSide: number): number {
  return (side * tracksPerSide + track) * ADFS_TRACK_BYTES;
}

export function parseAdfs(data: Uint8Array, doubleSided = false): DskImage {
  if (data.length === 0) throw new Error('ADFS image is empty');
  if (data.length > L_BYTES) throw new Error('ADFS image is larger than a 640K disc');
  const { tracks: numTracks, sides: numSides } = geometryFor(data.length, doubleSided);
  const total = numTracks * numSides * ADFS_TRACK_BYTES;
  if (data.length < total) {
    const full = new Uint8Array(total).fill(FILLER);
    full.set(data);
    data = full;
  }
  const tracks: (DskTrack | null)[][] = [];
  for (let t = 0; t < numTracks; t++) {
    const sides: (DskTrack | null)[] = new Array(numSides).fill(null);
    for (let s = 0; s < numSides; s++) {
      sides[s] = buildTrack(data, trackOffset(t, s, numTracks), t, s);
    }
    tracks.push(sides);
  }
  return {
    format: 'standard',
    numTracks,
    numSides,
    tracks,
    diskFormat: 'ADFS',
    protection: '',
  };
}

/** A blank ADFS disc: zeroed free-space map and root directory are what
 *  `*FORMAT` plus `*VERIFY` leave; the ADFS formatter itself writes the map,
 *  so a blank image is simply filler-filled and unformatted as far as the
 *  filing system is concerned. */
export function blankAdfs(tracks: 40 | 80, doubleSided: boolean): DskImage {
  // ADFS has no 40-track double-sided format (S is one side, L is 80 x 2).
  if (tracks === 40 && doubleSided) throw new Error('ADFS has no 40-track double-sided format');
  const sides = doubleSided ? 2 : 1;
  return parseAdfs(new Uint8Array(tracks * sides * ADFS_TRACK_BYTES).fill(FILLER), doubleSided);
}

export function serializeAdfs(image: DskImage): Uint8Array {
  const numSides = image.numSides === 2 ? 2 : 1;
  const out = new Uint8Array(image.numTracks * numSides * ADFS_TRACK_BYTES).fill(FILLER);
  for (let t = 0; t < image.numTracks; t++) {
    for (let s = 0; s < numSides; s++) {
      const track = image.tracks[t]?.[s];
      if (!track) continue;
      const base = trackOffset(t, s, image.numTracks);
      for (const sec of track.sectors) {
        if (sec.r < 0 || sec.r >= ADFS_SECTORS_PER_TRACK) continue;
        out.set(sec.data.subarray(0, ADFS_SECTOR_SIZE), base + sec.r * ADFS_SECTOR_SIZE);
      }
    }
  }
  return out;
}
