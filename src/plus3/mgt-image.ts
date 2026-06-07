/**
 * MGT +D disk images (.mgt / .img).
 *
 * Unlike the +3's DSK container, +D images are flat sector dumps with a fixed
 * geometry and no per-sector metadata. The standard +D disk is 800K:
 *   80 cylinders × 2 heads × 10 sectors × 512 bytes  (sectors numbered 1..10)
 * 720K (9 sectors/track) and single-sided variants also occur.
 *
 * The two extensions differ ONLY in track ordering — the byte content is
 * otherwise identical:
 *   .mgt — cylinder-major, sides interleaved:  C0/H0, C0/H1, C1/H0, C1/H1 …
 *   .img — side-major:  all of head 0 (C0..Cn), then all of head 1.
 *
 * We materialise images as the shared DskImage structure (see dsk.ts) so the
 * WD1772 core, the disk UI and the floppy-sound code can all be reused. Only
 * the parse (raw → DskImage) and serialize (DskImage → raw) steps are
 * +D-specific.
 */

import type { DskImage, DskTrack, DskSector } from './dsk.ts';

const SECTOR_BYTES = 512;

export type MgtImageExt = 'mgt' | 'img';

interface MgtGeometry { tracks: number; sides: number; spt: number; }

/** Known +D image sizes, matched before the generic divisor fallback. */
const KNOWN_SIZES: Record<number, MgtGeometry> = {
  819200: { tracks: 80, sides: 2, spt: 10 }, // 800K DS (the usual +D disk)
  737280: { tracks: 80, sides: 2, spt: 9 },  // 720K DS
  409600: { tracks: 80, sides: 1, spt: 10 }, // 400K SS
  368640: { tracks: 80, sides: 1, spt: 9 },  // 360K SS
};

function resolveGeometry(len: number): MgtGeometry | null {
  const known = KNOWN_SIZES[len];
  if (known) return known;
  // Generic fallback: assume 512-byte sectors and a common track/side count.
  for (const sides of [2, 1]) {
    for (const tracks of [80, 40]) {
      const per = tracks * sides * SECTOR_BYTES;
      if (len % per === 0) {
        const spt = len / per;
        if (spt >= 1 && spt <= 12) return { tracks, sides, spt };
      }
    }
  }
  return null;
}

/** Byte offset of the (cylinder, head) track block for the given ordering. */
function trackBlockIndex(ext: MgtImageExt, c: number, h: number, g: MgtGeometry): number {
  return ext === 'mgt'
    ? c * g.sides + h     // cylinder-major, sides interleaved
    : h * g.tracks + c;   // side-major
}

/** Infer the file extension form from a filename ('.img' → 'img', else 'mgt'). */
export function mgtExtFromName(filename: string): MgtImageExt {
  return filename.toLowerCase().endsWith('.img') ? 'img' : 'mgt';
}

/** Returns true if the size matches a recognised +D geometry. */
export function isMgtSize(len: number): boolean {
  return resolveGeometry(len) !== null;
}

/**
 * Parse a raw .mgt/.img dump into a DskImage. Returns null if the file size
 * doesn't correspond to a recognised +D geometry.
 */
export function parseMgt(data: Uint8Array, ext: MgtImageExt): DskImage | null {
  const g = resolveGeometry(data.length);
  if (!g) return null;

  const tracks: (DskTrack | null)[][] = [];
  for (let c = 0; c < g.tracks; c++) {
    const sides: (DskTrack | null)[] = [];
    for (let h = 0; h < g.sides; h++) {
      const base = trackBlockIndex(ext, c, h, g) * g.spt * SECTOR_BYTES;
      const sectors: DskSector[] = [];
      const sectorMap = new Map<number, number>();
      for (let s = 0; s < g.spt; s++) {
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
    diskFormat: 'MGT +D',
    protection: '',
  };
}

/**
 * Serialize a DskImage back to a flat .mgt/.img dump. Sectors per track are
 * taken from track 0; missing tracks/sectors are written as zeros.
 */
export function serializeMgt(img: DskImage, ext: MgtImageExt): Uint8Array {
  const tracks = img.numTracks;
  const sides = img.numSides;
  const t0 = img.tracks[0]?.[0];
  const spt = t0 ? t0.sectors.length : 10;
  const g: MgtGeometry = { tracks, sides, spt };

  const out = new Uint8Array(tracks * sides * spt * SECTOR_BYTES);
  for (let c = 0; c < tracks; c++) {
    for (let h = 0; h < sides; h++) {
      const track = img.tracks[c]?.[h];
      if (!track) continue;
      const base = trackBlockIndex(ext, c, h, g) * spt * SECTOR_BYTES;
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
 * Build a blank, unformatted 800K +D disk (all sectors present, filled with the
 * standard 0xE5 filler). The user formats it with G+DOS to write a directory;
 * the sectors already exist so saves land even before a full format.
 */
export function blankMgtDisk(): DskImage {
  const tracks = 80, sides = 2, spt = 10;
  const out: (DskTrack | null)[][] = [];
  for (let c = 0; c < tracks; c++) {
    const sideArr: (DskTrack | null)[] = [];
    for (let h = 0; h < sides; h++) {
      const sectors: DskSector[] = [];
      const sectorMap = new Map<number, number>();
      for (let s = 0; s < spt; s++) {
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
    diskFormat: 'MGT +D',
    protection: '',
  };
}
