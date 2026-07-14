/**
 * DSK disk image parser for ZX Spectrum +3.
 *
 * Supports both standard ("MV - CPC") and extended ("EXTENDED") DSK formats
 * as used by the Amstrad CPC / ZX Spectrum +3.
 */

import { detectDiskFormat, detectProtection, isFlippyDisk } from './disk-detect.ts';

// ── Data structures ─────────────────────────────────────────────────────────

export interface DskSector {
  c: number;           // Cylinder (track) from CHRN
  h: number;           // Head (side) from CHRN
  r: number;           // Record (sector ID) from CHRN
  n: number;           // Size code from CHRN
  st1: number;         // FDC status register 1
  st2: number;         // FDC status register 2
  data: Uint8Array;    // Primary sector data (copies[0] when multi-copy)
  /**
   * Simon Owen v5 EDSK extension: multiple stored copies of a weak
   * sector. When sibDataLen is K × (128<<N) for K ≥ 2, the SAMdisk
   * convention is that the on-disk storage contains K real reads of
   * the same sector with weak bits manifesting as byte differences.
   * On read the FDC picks one copy at random.
   *
   * Undefined for ordinary single-copy sectors.
   */
  copies?: Uint8Array[];
}

export interface DskTrack {
  sectors: DskSector[];
  /** Map from sector R value → index into sectors[] for O(1) lookup */
  sectorMap: Map<number, number>;
  gap3: number;
  filler: number;
}

/**
 * Raw per-track MFM bit-cell streams retained from an HFE image. When present
 * the mounted disk *is* the HFE bitstream: the FDC's decoded {@link DskTrack}s
 * are derived from `cells[cylinder][side]` (see `plus3/hfe.ts`), not from a DSK
 * file, and the flux stays attached for on-demand re-decode / future write-back.
 */
/** Where one decoded sector's data field sits in a track's cell stream, so a
 *  write can be re-encoded back into the bitstream in place (see serializeHFE). */
export interface HfeSectorLayout {
  /** Bit offset in the side's cells where the data payload begins. */
  dataBit: number;
  /** Payload byte length laid on the track (128 << N, or a truncated field). */
  len: number;
  /** Data address mark: 0xFB (data) or 0xF8 (deleted-data). */
  mark: number;
}

export interface HfeBitstream {
  /** cells[cylinder][side] — LSB-first MFM bit-cells, or null for a blank side. */
  cells: (Uint8Array | null)[][];
  /**
   * Physical-order data-field positions per [cylinder][side], parallel to the
   * decoded `tracks[cyl][side].sectors`, used to patch writes back into `cells`.
   */
  layout: (HfeSectorLayout[] | null)[][];
}

export interface DskImage {
  format: 'standard' | 'extended';
  numTracks: number;
  numSides: number;
  /** tracks[cylinder][side] */
  tracks: (DskTrack | null)[][];
  /** Present only for HFE-sourced disks: the retained raw MFM bitstream. */
  bitstream?: HfeBitstream;
  /** Detected disk format name (e.g. "+3DOS", "CPC System") */
  diskFormat: string;
  /** Detected copy protection scheme, or empty string */
  protection: string;
  /**
   * True for a combined "flippy" disk: two independent single-sided 180K
   * +3/PCW sides packed into one DSK (Side A = image side 0, Side B = side 1).
   * The UI offers a "flip" control; the FDC presents one side at a time via
   * its per-drive flipSide offset. See {@link isFlippyDisk}.
   */
  flippy?: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function u16LE(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8);
}

function asciiAt(data: Uint8Array, offset: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(data[offset + i]);
  return s;
}

// ── Track parser ────────────────────────────────────────────────────────────

function parseTrack(data: Uint8Array, trackOffset: number, trackSize: number, isExtended: boolean): DskTrack | null {
  if (trackSize < 256) return null;

  const magic = asciiAt(data, trackOffset, 12);
  if (!magic.startsWith('Track-Info')) return null;

  const sectorCount = data[trackOffset + 0x15];
  const gap3 = data[trackOffset + 0x16];
  const filler = data[trackOffset + 0x17];

  const sectors: DskSector[] = [];
  const sectorMap = new Map<number, number>();

  let dataOffset = trackOffset + 0x100; // sector data starts after 256-byte header

  for (let i = 0; i < sectorCount; i++) {
    const sibOffset = trackOffset + 0x18 + i * 8;
    const c = data[sibOffset];
    const h = data[sibOffset + 1];
    const r = data[sibOffset + 2];
    const n = data[sibOffset + 3];
    const st1 = data[sibOffset + 4];
    const st2 = data[sibOffset + 5];
    const sibDataLen = u16LE(data, sibOffset + 6);

    // Actual stored size: extended format uses SIB dataLen, standard uses 128 << N
    let actualSize: number;
    if (isExtended && sibDataLen > 0) {
      actualSize = sibDataLen;
    } else {
      actualSize = n <= 5 ? (128 << n) : n === 6 ? 6144 : 0;
    }

    // Extract sector data, handling truncated files gracefully
    let sectorData: Uint8Array;
    if (dataOffset + actualSize <= data.length) {
      sectorData = data.slice(dataOffset, dataOffset + actualSize);
    } else if (dataOffset < data.length) {
      sectorData = new Uint8Array(actualSize);
      sectorData.set(data.subarray(dataOffset, data.length));
      sectorData.fill(filler, data.length - dataOffset);
    } else {
      sectorData = new Uint8Array(actualSize);
      sectorData.fill(filler);
    }

    // Simon Owen v5 multi-copy detection: when the stored data is an
    // exact multiple ≥ 2 of the N-coded physical size, split it into
    // copies. Anything else (short sectors, oversized non-multiple
    // protection sectors) stays as a single buffer.
    const physSize = n <= 5 ? (128 << n) : n === 6 ? 6144 : 128 << n;
    const sector: DskSector = { c, h, r, n, st1, st2, data: sectorData };
    if (isExtended && physSize > 0 && actualSize >= 2 * physSize && actualSize % physSize === 0) {
      const copyCount = actualSize / physSize;
      const copies: Uint8Array[] = [];
      for (let k = 0; k < copyCount; k++) {
        copies.push(sectorData.subarray(k * physSize, (k + 1) * physSize));
      }
      sector.copies = copies;
      // data points at the first copy so single-copy consumers stay sane.
      sector.data = copies[0];
    }
    sectors.push(sector);
    // Duplicate sector IDs (deliberate on protection tracks) resolve to the
    // FIRST physical occurrence, matching real hardware: the FDC finds
    // whichever copy the head reaches first during rotation and stops there.
    if (!sectorMap.has(r)) sectorMap.set(r, i);
    dataOffset += actualSize;
  }

  return { sectors, sectorMap, gap3, filler };
}

// ── Main parser ─────────────────────────────────────────────────────────────

export function parseDSK(data: Uint8Array): DskImage {
  if (data.length < 256) throw new Error('DSK file too small');

  const magic = asciiAt(data, 0, 8);
  let isExtended: boolean;
  if (magic === 'EXTENDED') {
    isExtended = true;
  } else if (magic === 'MV - CPC') {
    isExtended = false;
  } else {
    throw new Error('Not a valid DSK file');
  }

  const numTracks = data[0x30];
  const numSides = data[0x31];

  if (numTracks === 0 || numSides === 0) throw new Error('DSK has no tracks');

  // Build track size table
  const totalTracks = numTracks * numSides;
  const trackSizes: number[] = [];

  if (isExtended) {
    // Extended: per-track sizes at 0x34, each byte × 256
    for (let i = 0; i < totalTracks; i++) {
      trackSizes.push(data[0x34 + i] * 256);
    }
  } else {
    // Standard: fixed track size from u16LE at 0x32
    const fixedSize = u16LE(data, 0x32);
    for (let i = 0; i < totalTracks; i++) {
      trackSizes.push(fixedSize);
    }
  }

  // Allocate tracks[cylinder][side]
  const tracks: (DskTrack | null)[][] = [];
  for (let t = 0; t < numTracks; t++) {
    tracks.push(new Array(numSides).fill(null));
  }

  // Parse each track
  let offset = 256; // skip disk info block
  for (let t = 0; t < numTracks; t++) {
    for (let s = 0; s < numSides; s++) {
      const idx = t * numSides + s;
      const size = trackSizes[idx];
      if (size === 0) {
        // Unformatted track
        continue;
      }
      tracks[t][s] = parseTrack(data, offset, size, isExtended);
      offset += size;
    }
  }

  const image: DskImage = {
    format: isExtended ? 'extended' : 'standard',
    numTracks,
    numSides,
    tracks,
    diskFormat: '',
    protection: '',
  };

  image.diskFormat = detectDiskFormat(image);
  image.protection = detectProtection(image);
  image.flippy = isFlippyDisk(image);
  return image;
}

// ── DSK serializer ──────────────────────────────────────────────────────────

function writeAscii(buf: Uint8Array, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) buf[offset + i] = str.charCodeAt(i);
}

function writeU16LE(buf: Uint8Array, offset: number, val: number): void {
  buf[offset] = val & 0xFF;
  buf[offset + 1] = (val >> 8) & 0xFF;
}

/** Serialize a DskImage to extended DSK format bytes. */
export function serializeDSK(image: DskImage): Uint8Array {
  const { numTracks, numSides, tracks } = image;
  const totalTracks = numTracks * numSides;

  // Per-sector stored length: total bytes the SIB will advertise. For
  // single-copy sectors this is data.length; for v5 multi-copy weak
  // sectors it's the sum of all copies.
  const sectorStoredLen = (s: DskSector): number => {
    if (s.copies && s.copies.length > 1) {
      let total = 0;
      for (const c of s.copies) total += c.length;
      return total;
    }
    return s.data.length;
  };

  // First pass: compute per-track sizes (256-byte header + actual sector data)
  const trackSizes: number[] = [];
  for (let cyl = 0; cyl < numTracks; cyl++) {
    for (let side = 0; side < numSides; side++) {
      const track = tracks[cyl]?.[side];
      if (!track || track.sectors.length === 0) {
        trackSizes.push(0);
      } else {
        let dataBytes = 0;
        for (const s of track.sectors) dataBytes += sectorStoredLen(s);
        // EDSK per-track size table at 0x34 stores size/256, so each track's
        // allocation in the file must be a 256-byte multiple. Pad with zeros
        // when sector data totals aren't aligned (e.g. short protection
        // sectors). The reader uses the table for offsets, so an unaligned
        // raw layout would desync every subsequent track.
        trackSizes.push(Math.ceil((256 + dataBytes) / 256) * 256);
      }
    }
  }

  let fileSize = 256; // disk info block
  for (const ts of trackSizes) fileSize += ts;
  const buf = new Uint8Array(fileSize);

  // Disk Information Block (256 bytes)
  writeAscii(buf, 0, 'EXTENDED CPC DSK File\r\nDisk-Info\r\n');
  writeAscii(buf, 0x22, 'ZX84\0');
  buf[0x30] = numTracks;
  buf[0x31] = numSides;
  // 0x32-0x33 unused in extended format
  // Track size table at 0x34: each byte = track size / 256
  for (let i = 0; i < totalTracks; i++) {
    buf[0x34 + i] = trackSizes[i] / 256;
  }

  // Write each track
  let offset = 256;
  let trackIdx = 0;
  for (let cyl = 0; cyl < numTracks; cyl++) {
    for (let side = 0; side < numSides; side++) {
      const track = tracks[cyl]?.[side];
      if (trackSizes[trackIdx] === 0) { trackIdx++; continue; }

      // Track Information Block header
      writeAscii(buf, offset, 'Track-Info\r\n');
      buf[offset + 0x10] = cyl;
      buf[offset + 0x11] = side;
      buf[offset + 0x14] = track!.sectors[0]?.n ?? 2;
      buf[offset + 0x15] = track!.sectors.length;
      buf[offset + 0x16] = track!.gap3;
      buf[offset + 0x17] = track!.filler;

      // Sector Information List
      for (let i = 0; i < track!.sectors.length; i++) {
        const s = track!.sectors[i];
        const sib = offset + 0x18 + i * 8;
        buf[sib + 0] = s.c;
        buf[sib + 1] = s.h;
        buf[sib + 2] = s.r;
        buf[sib + 3] = s.n;
        buf[sib + 4] = s.st1;
        buf[sib + 5] = s.st2;
        writeU16LE(buf, sib + 6, sectorStoredLen(s));
      }

      // Sector data — multi-copy weak sectors emit each copy in turn.
      let dataOff = offset + 256;
      for (const s of track!.sectors) {
        if (s.copies && s.copies.length > 1) {
          for (const c of s.copies) {
            buf.set(c, dataOff);
            dataOff += c.length;
          }
        } else {
          buf.set(s.data, dataOff);
          dataOff += s.data.length;
        }
      }

      offset += trackSizes[trackIdx];
      trackIdx++;
    }
  }

  return buf;
}

// ── Blank disk creation ─────────────────────────────────────────────────────

export interface DiskFormat {
  label: string;
  sides: number;        // 1 = SS, 2 = DS
  tracks: number;       // tracks per side
  sectors: number;      // sectors per track
  sectorSize: number;   // bytes per sector
  gap3: number;         // gap length (format)
  gapRW: number;        // gap length (read/write)
  filler: number;       // filler byte
  firstSector: number;  // first sector ID
  resTracks: number;    // reserved tracks (system/boot)
  blockShift: number;   // BSH — block size = 128 << BSH
  dirBlocks: number;    // directory blocks
  diskType: number;     // +3DOS disk type byte
  /**
   * AMSDOS/CP/M disk (Amstrad CPC). Unlike +3DOS/PCW disks, these carry no
   * disk-specification block in track 0 — the format is identified solely by
   * the track-0 sector IDs. createBlankDisk skips the spec block for these.
   */
  cpc?: boolean;
}

function formatCapacityKB(fmt: DiskFormat): number {
  return (fmt.sides * fmt.tracks * fmt.sectors * fmt.sectorSize) / 1024;
}

export const DISK_FORMATS: DiskFormat[] = [
  {
    label: 'PCW/+3 Single',
    diskType: 0,
    sides: 1, tracks: 40, sectors: 9, sectorSize: 512,
    gapRW: 42, gap3: 82, filler: 0xE5, firstSector: 1,
    resTracks: 1, blockShift: 3, dirBlocks: 2,
  },
  {
    label: 'PCW Double',
    diskType: 3,
    sides: 2, tracks: 80, sectors: 9, sectorSize: 512,
    gapRW: 42, gap3: 82, filler: 0xE5, firstSector: 1,
    resTracks: 1, blockShift: 4, dirBlocks: 4,
  },
  // Amstrad CPC AMSDOS formats. Distinguished from PCW/+3 by their track-0
  // sector-ID ranges (&41.. / &C1.. / &01..). System reserves 2 tracks for a
  // bootable CP/M; Data reserves none; IBM is the CP/M 2.2-compatible 8-sector
  // layout. No +3DOS spec block is written (cpc: true).
  {
    label: 'CPC System',
    diskType: 0, cpc: true,
    sides: 1, tracks: 40, sectors: 9, sectorSize: 512,
    gapRW: 42, gap3: 82, filler: 0xE5, firstSector: 0x41,
    resTracks: 2, blockShift: 3, dirBlocks: 2,
  },
  {
    label: 'CPC Data',
    diskType: 0, cpc: true,
    sides: 1, tracks: 40, sectors: 9, sectorSize: 512,
    gapRW: 42, gap3: 82, filler: 0xE5, firstSector: 0xC1,
    resTracks: 0, blockShift: 3, dirBlocks: 2,
  },
  {
    label: 'CPC IBM',
    diskType: 0, cpc: true,
    sides: 1, tracks: 40, sectors: 8, sectorSize: 512,
    gapRW: 42, gap3: 82, filler: 0xE5, firstSector: 0x01,
    resTracks: 1, blockShift: 3, dirBlocks: 2,
  },
];

/** Label with capacity, e.g. "+3DOS / PCW CF2 (180K)" */
export function formatLabel(fmt: DiskFormat): string {
  return `${fmt.label} (${formatCapacityKB(fmt)}K)`;
}

export function createBlankDisk(fmt: DiskFormat): DskImage {
  const sizeCode = Math.log2(fmt.sectorSize / 128); // N value: 512 → 2
  const tracks: (DskTrack | null)[][] = [];

  for (let cyl = 0; cyl < fmt.tracks; cyl++) {
    const sides: (DskTrack | null)[] = [];
    for (let head = 0; head < fmt.sides; head++) {
      const sectors: DskSector[] = [];
      const sectorMap = new Map<number, number>();
      for (let i = 0; i < fmt.sectors; i++) {
        const r = fmt.firstSector + i;
        const data = new Uint8Array(fmt.sectorSize);
        data.fill(fmt.filler);
        sectors.push({ c: cyl, h: head, r, n: sizeCode, st1: 0, st2: 0, data });
        sectorMap.set(r, i);
      }
      sides.push({ sectors, sectorMap, gap3: fmt.gap3, filler: fmt.filler });
    }
    tracks.push(sides);
  }

  // Write +3DOS disk specification block into first sector of track 0.
  // CPC AMSDOS disks have no such block — the format is identified by the
  // track-0 sector IDs alone, and sector 0 is part of the directory/data area,
  // so writing a spec block there would corrupt it.
  if (!fmt.cpc) {
    const bootSector = tracks[0][0]!.sectors[0].data;
    bootSector[0] = fmt.diskType;           // disk type
    bootSector[1] = fmt.sides === 1 ? 0 : 1; // sidedness: 0=SS, 1=DS alternating
    bootSector[2] = fmt.tracks;             // tracks per side
    bootSector[3] = fmt.sectors;            // sectors per track
    bootSector[4] = sizeCode;              // sector size log (2 = 512)
    bootSector[5] = fmt.resTracks;          // reserved tracks
    bootSector[6] = fmt.blockShift;         // BSH
    bootSector[7] = fmt.dirBlocks;          // directory blocks
    bootSector[8] = fmt.gapRW;             // gap length (R/W)
    bootSector[9] = fmt.gap3;              // gap length (format)
  }

  const image: DskImage = {
    format: 'standard',
    numTracks: fmt.tracks,
    numSides: fmt.sides,
    tracks,
    diskFormat: '',
    protection: '',
  };
  image.diskFormat = detectDiskFormat(image);
  return image;
}

/** Re-detect diskFormat and protection after in-place modification (e.g. format). */
export function refreshDiskMetadata(image: DskImage): void {
  image.diskFormat = detectDiskFormat(image);
  image.protection = detectProtection(image);
  image.flippy = isFlippyDisk(image);
}
