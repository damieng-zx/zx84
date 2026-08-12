/**
 * TR-DOS disk images (.trd) for the Beta Disk interface.
 *
 * A TRD is a flat sector dump — like the +D's .mgt (see mgt-image.ts) but with
 * TR-DOS geometry: 16 sectors × 256 bytes per track, sectors numbered 1..16,
 * size code n = 1. Tracks are stored cylinder-major with the two sides
 * interleaved (C0/H0, C0/H1, C1/H0 …), which is also TR-DOS's own "logical
 * track" order (logical track = cylinder × sides + side), so a file's linear
 * TR-DOS sector address maps straight to a byte offset in the image.
 *
 * We materialise images as the shared DskImage structure (dsk.ts) so the WD1793
 * core, the disk UI and the floppy-sound code are all reused; only the parse
 * (raw → DskImage) and serialize (DskImage → raw) steps are TR-DOS-specific.
 *
 * Two wrinkles beyond the +D's fixed-size images:
 *   • Geometry comes from the disk-info sector (track 0, sector 9) — its disk
 *     type byte disambiguates the 327680-byte size (80-track SS vs 40-track DS).
 *   • Real TRDs frequently omit trailing empty tracks, so the file is often
 *     shorter than the full geometry; missing/short sectors are zero-padded.
 */

import type { DskImage, DskTrack, DskSector } from './disk-image.ts';

export const TRD_SECTOR_BYTES = 256;
export const TRD_SPT = 16;

export interface TrdGeometry { tracks: number; sides: number; }

/** Disk-info sector byte offsets (within track 0 / sector 9). */
const INFO_SECTOR_OFFSET = 8 * TRD_SECTOR_BYTES; // track 0, sector 9 (0-based 8)
const OFF_FIRST_FREE_SECTOR = 0xE1;
const OFF_FIRST_FREE_TRACK  = 0xE2;
const OFF_DISK_TYPE         = 0xE3;
const OFF_FILE_COUNT        = 0xE4;
const OFF_FREE_SECTORS      = 0xE5; // word, LE
const OFF_TRDOS_ID          = 0xE7; // = 0x10
const OFF_LABEL             = 0xF5; // 8 bytes

/** Disk-type byte (offset 0xE3 of the info sector) → physical geometry. */
const DISK_TYPE_GEOMETRY: Record<number, TrdGeometry> = {
  0x16: { tracks: 80, sides: 2 },
  0x17: { tracks: 40, sides: 2 },
  0x18: { tracks: 80, sides: 1 },
  0x19: { tracks: 40, sides: 1 },
};

/** Exact TRD sizes, tried in this order when there is no valid disk-type byte. */
const SIZE_GEOMETRY: TrdGeometry[] = [
  { tracks: 80, sides: 2 }, // 655360 (the usual 640K disk)
  { tracks: 80, sides: 1 }, // 327680 (also 40×2 — prefer 80×1)
  { tracks: 40, sides: 2 }, // 327680
  { tracks: 40, sides: 1 }, // 163840
];

function geometryBytes(g: TrdGeometry): number {
  return g.tracks * g.sides * TRD_SPT * TRD_SECTOR_BYTES;
}

/** Resolve the geometry: the disk-type byte is authoritative; fall back to an
 *  exact length match, then to the common 80-track DS layout (padding short). */
export function resolveTrdGeometry(data: Uint8Array): TrdGeometry {
  if (data.length > INFO_SECTOR_OFFSET + OFF_DISK_TYPE) {
    const g = DISK_TYPE_GEOMETRY[data[INFO_SECTOR_OFFSET + OFF_DISK_TYPE]];
    if (g) return g;
  }
  for (const g of SIZE_GEOMETRY) {
    if (geometryBytes(g) === data.length) return g;
  }
  return { tracks: 80, sides: 2 };
}

/** True if the size is a plausible TRD (a whole number of 256-byte sectors,
 *  no larger than an 80-track double-sided disk). */
export function isTrdSize(len: number): boolean {
  return len > 0 && len % TRD_SECTOR_BYTES === 0
    && len <= 80 * 2 * TRD_SPT * TRD_SECTOR_BYTES;
}

/** Byte offset of the (cylinder, side) track block — cylinder-major, sides
 *  interleaved (identical to TR-DOS logical-track ordering). */
function trackBlockOffset(c: number, h: number, sides: number): number {
  return (c * sides + h) * TRD_SPT * TRD_SECTOR_BYTES;
}

/**
 * Parse a raw .trd dump into a DskImage. The full geometry is always
 * materialised; sectors past the end of a truncated file are zero-filled.
 */
export function parseTrd(data: Uint8Array): DskImage {
  if (!isTrdSize(data.length)) throw new Error(`Invalid TRD image size: ${data.length}`);
  const g = resolveTrdGeometry(data);
  const tracks: (DskTrack | null)[][] = [];
  for (let c = 0; c < g.tracks; c++) {
    const sides: (DskTrack | null)[] = [];
    for (let h = 0; h < g.sides; h++) {
      const base = trackBlockOffset(c, h, g.sides);
      const sectors: DskSector[] = [];
      const sectorMap = new Map<number, number>();
      for (let s = 0; s < TRD_SPT; s++) {
        const r = s + 1;
        const off = base + s * TRD_SECTOR_BYTES;
        const d = new Uint8Array(TRD_SECTOR_BYTES);
        if (off < data.length) d.set(data.subarray(off, off + TRD_SECTOR_BYTES));
        sectors.push({ c, h, r, n: 1, st1: 0, st2: 0, data: d });
        sectorMap.set(r, s);
      }
      sides.push({ sectors, sectorMap, gap3: 0x2A, filler: 0x00 });
    }
    tracks.push(sides);
  }

  return {
    format: 'standard',
    numTracks: g.tracks,
    numSides: g.sides,
    tracks,
    diskFormat: 'TR-DOS',
    protection: '',
  };
}

/**
 * Serialize a DskImage back to a flat .trd dump. Geometry is taken from the
 * image; missing tracks/sectors are written as zeros.
 */
export function serializeTrd(img: DskImage): Uint8Array {
  const tracks = img.numTracks;
  const sides = img.numSides;
  const out = new Uint8Array(tracks * sides * TRD_SPT * TRD_SECTOR_BYTES);
  for (let c = 0; c < tracks; c++) {
    for (let h = 0; h < sides; h++) {
      const track = img.tracks[c]?.[h];
      if (!track) continue;
      const base = trackBlockOffset(c, h, sides);
      for (let s = 0; s < TRD_SPT; s++) {
        const idx = track.sectorMap.get(s + 1);
        if (idx === undefined) continue;
        out.set(track.sectors[idx].data.subarray(0, TRD_SECTOR_BYTES), base + s * TRD_SECTOR_BYTES);
      }
    }
  }
  return out;
}

/** Disk-type byte for a given geometry (default 0x16 for 80×2). */
function diskTypeByte(g: TrdGeometry): number {
  for (const [k, v] of Object.entries(DISK_TYPE_GEOMETRY)) {
    if (v.tracks === g.tracks && v.sides === g.sides) return Number(k);
  }
  return 0x16;
}

/**
 * Write a valid, empty TR-DOS disk-info sector (track 0, sector 9) into a flat
 * image buffer. Leaves the disk ready for TR-DOS to CAT/SAVE without a format.
 */
export function writeTrdInfoSector(
  flat: Uint8Array,
  g: TrdGeometry,
  opts: { fileCount?: number; firstFreeTrack?: number; firstFreeSector?: number; label?: string } = {},
): void {
  const total = g.tracks * g.sides * TRD_SPT;
  const fileCount = opts.fileCount ?? 0;
  const firstFreeTrack = opts.firstFreeTrack ?? 1;    // track 0 is reserved
  const firstFreeSector = opts.firstFreeSector ?? 0;
  const usedSectors = firstFreeTrack * TRD_SPT + firstFreeSector;
  const freeSectors = Math.max(0, total - usedSectors);
  const o = INFO_SECTOR_OFFSET;
  flat[o + OFF_FIRST_FREE_SECTOR] = firstFreeSector & 0xFF;
  flat[o + OFF_FIRST_FREE_TRACK]  = firstFreeTrack & 0xFF;
  flat[o + OFF_DISK_TYPE]         = diskTypeByte(g);
  flat[o + OFF_FILE_COUNT]        = fileCount & 0xFF;
  flat[o + OFF_FREE_SECTORS]      = freeSectors & 0xFF;
  flat[o + OFF_FREE_SECTORS + 1]  = (freeSectors >> 8) & 0xFF;
  flat[o + OFF_TRDOS_ID]          = 0x10;
  const label = (opts.label ?? '').padEnd(8, ' ').slice(0, 8);
  for (let i = 0; i < 8; i++) flat[o + OFF_LABEL + i] = label.charCodeAt(i) & 0xFF;
}

/**
 * Build a blank, pre-initialised TR-DOS disk (empty directory, valid info
 * sector). Defaults to the 640K 80-track double-sided layout.
 */
export function blankTrdDisk(tracks = 80, sides = 2): DskImage {
  const g: TrdGeometry = { tracks, sides };
  const flat = new Uint8Array(geometryBytes(g));
  writeTrdInfoSector(flat, g);
  return parseTrd(flat);
}
