/**
 * Camputers Lynx disk images (.ldf).
 *
 * A headerless raw sector dump for the FD1793, as used by the Pale emulator.
 * There is no inter-sector information: the file is just the 512 bytes of each
 * sector in cylinder-major, head-minor order (C0/H0, C0/H1, C1/H0, …). MAME's
 * `formats/camplynx_dsk.cpp`:
 *
 *   200K disks are single sided 40 tracks  (40 × 1 × 10 × 512 = 204,800 bytes)
 *   800K disks are double sided 80 tracks  (80 × 2 × 10 × 512 = 819,200 bytes)
 *
 * The disk is MFM with 10 sectors a track, numbered 1..10, so a sector's size
 * code is 2 (512 bytes). Materialised as the shared DskImage structure so the
 * WD1793 core, the disk UI and the floppy-sound code can all be reused — only
 * the parse (raw → DskImage) and serialize (DskImage → raw) are Lynx-specific.
 */

import type { DskImage, DskTrack, DskSector } from './disk-image.ts';

const SECTOR_BYTES = 512;
const SECTORS_PER_TRACK = 10;

interface LdfGeometry { tracks: number; sides: number; }

/** Known Lynx image sizes, matched before the generic divisor fallback. */
const KNOWN_SIZES: Record<number, LdfGeometry> = {
  204800: { tracks: 40, sides: 1 }, // 200K single sided
  819200: { tracks: 80, sides: 2 }, // 800K double sided
};

function resolveGeometry(len: number): LdfGeometry | null {
  const known = KNOWN_SIZES[len];
  if (known) return known;
  const perTrack = SECTORS_PER_TRACK * SECTOR_BYTES;
  for (const sides of [2, 1]) {
    for (const tracks of [80, 40]) {
      if (len === tracks * sides * perTrack) return { tracks, sides };
    }
  }
  return null;
}

/** Byte offset of the (cylinder, head) track block: cylinder-major, heads interleaved. */
function trackBlockIndex(c: number, h: number, g: LdfGeometry): number {
  return c * g.sides + h;
}

/** Returns true if the size matches a recognised Lynx geometry. */
export function isLdfSize(len: number): boolean {
  return resolveGeometry(len) !== null;
}

/** Parse a raw .ldf dump into a DskImage, or null for an unrecognised size. */
export function parseLdf(data: Uint8Array): DskImage | null {
  const g = resolveGeometry(data.length);
  if (!g) return null;

  const tracks: (DskTrack | null)[][] = [];
  for (let c = 0; c < g.tracks; c++) {
    const sides: (DskTrack | null)[] = [];
    for (let h = 0; h < g.sides; h++) {
      const base = trackBlockIndex(c, h, g) * SECTORS_PER_TRACK * SECTOR_BYTES;
      const sectors: DskSector[] = [];
      const sectorMap = new Map<number, number>();
      for (let s = 0; s < SECTORS_PER_TRACK; s++) {
        const r = s + 1;
        const off = base + s * SECTOR_BYTES;
        const d = new Uint8Array(SECTOR_BYTES);
        d.set(data.subarray(off, off + SECTOR_BYTES));
        sectors.push({ c, h, r, n: 2, st1: 0, st2: 0, data: d });
        sectorMap.set(r, s);
      }
      sides.push({ sectors, sectorMap, gap3: 82, filler: 0xE5 });
    }
    tracks.push(sides);
  }

  return {
    format: 'standard',
    numTracks: g.tracks,
    numSides: g.sides,
    tracks,
    diskFormat: 'Lynx LDF',
    protection: '',
  };
}

/** Serialize a DskImage back to a flat .ldf dump. Missing tracks/sectors are zeros. */
export function serializeLdf(img: DskImage): Uint8Array {
  const tracks = img.numTracks;
  const sides = img.numSides;
  const spt = img.tracks[0]?.[0]?.sectors.length ?? SECTORS_PER_TRACK;
  const g: LdfGeometry = { tracks, sides };

  const out = new Uint8Array(tracks * sides * spt * SECTOR_BYTES);
  for (let c = 0; c < tracks; c++) {
    for (let h = 0; h < sides; h++) {
      const track = img.tracks[c]?.[h];
      if (!track) continue;
      const base = trackBlockIndex(c, h, g) * spt * SECTOR_BYTES;
      for (let s = 0; s < spt; s++) {
        const idx = track.sectorMap.get(s + 1);
        if (idx === undefined) continue;
        out.set(track.sectors[idx].data.subarray(0, SECTOR_BYTES), base + s * SECTOR_BYTES);
      }
    }
  }
  return out;
}

/**
 * Build a blank Lynx disk (all sectors present, filled with the 0xE5 filler).
 * Defaults to the 800K double-sided/80-track layout; pass `tracks`/`sides` for
 * the 200K single-sided variant (both use 10 × 512-byte sectors).
 */
export function blankLdfDisk(tracks = 80, sides = 2): DskImage {
  const out: (DskTrack | null)[][] = [];
  for (let c = 0; c < tracks; c++) {
    const sideArr: (DskTrack | null)[] = [];
    for (let h = 0; h < sides; h++) {
      const sectors: DskSector[] = [];
      const sectorMap = new Map<number, number>();
      for (let s = 0; s < SECTORS_PER_TRACK; s++) {
        const r = s + 1;
        const data = new Uint8Array(SECTOR_BYTES);
        data.fill(0xE5);
        sectors.push({ c, h, r, n: 2, st1: 0, st2: 0, data });
        sectorMap.set(r, s);
      }
      sideArr.push({ sectors, sectorMap, gap3: 82, filler: 0xE5 });
    }
    out.push(sideArr);
  }
  return {
    format: 'standard',
    numTracks: tracks,
    numSides: sides,
    tracks: out,
    diskFormat: 'Lynx LDF',
    protection: '',
  };
}
