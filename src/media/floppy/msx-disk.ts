/**
 * MSX-DOS floppy images.
 *
 * MSX disks are ordinary FAT12 volumes of 512-byte MFM sectors, numbered from 1
 * on every track. MSX-DOS 1 ignores the BPB entirely and derives the whole
 * geometry from the *media descriptor* byte (the first byte of the FAT), so
 * that byte is also what tells a 360K single-sided 80-track disk from a 360K
 * double-sided 40-track one — the two have identical file sizes.
 *
 *   FF  40 tracks, 2 sides, 8 sectors   320K  (5.25")
 *   FE  40 tracks, 1 side,  8 sectors   160K  (5.25")
 *   FD  40 tracks, 2 sides, 9 sectors   360K  (5.25")
 *   FC  40 tracks, 1 side,  9 sectors   180K  (5.25")
 *   FB  80 tracks, 2 sides, 8 sectors   640K  (3.5")
 *   FA  80 tracks, 1 side,  8 sectors   320K  (3.5")
 *   F9  80 tracks, 2 sides, 9 sectors   720K  (3.5")
 *   F8  80 tracks, 1 side,  9 sectors   360K  (3.5")
 *
 * Formats read here:
 *   .dsk  headerless sector dump, cylinder-major / head-minor logical order
 *   .img  the same preceded by one header byte (1 = single, 2 = double sided)
 *   .dmk  David Keil's track dump: keeps CRC errors, deleted marks and odd
 *         sector layouts, so protected disks survive
 * Other containers (HFE, SCP, Teledisk, extended CPC DSK) are decoded by their
 * own modules; {@link parseMsxFloppy} routes between all of them.
 */

import type { DskImage, DskSector, DskTrack } from './disk-image.ts';
import { isHFE, parseFloppyImage } from './hfe.ts';
import { isScp } from './scp.ts';
import { isTd0 } from './td0.ts';

export const MSX_SECTOR_SIZE = 512;
/** First byte of a Gap-3-filled data area as left by the MSX-DOS formatter. */
const FORMAT_FILLER = 0xE5;
const DEFAULT_GAP3 = 0x2A;
/** Longest run of spare bytes after the last sector that is still ignored. */
const MAX_TRAILING_BYTES = 65536;

export interface MsxGeometry {
  /** Media descriptor byte. */
  readonly id: number;
  readonly tracks: number;
  readonly sides: number;
  readonly sectorsPerTrack: number;
  readonly sectorsPerCluster: number;
  readonly rootEntries: number;
  readonly sectorsPerFat: number;
  readonly label: string;
}

export const MSX_GEOMETRIES: readonly MsxGeometry[] = [
  { id: 0xF8, tracks: 80, sides: 1, sectorsPerTrack: 9, sectorsPerCluster: 2, rootEntries: 112, sectorsPerFat: 2, label: '360K SS/80T' },
  { id: 0xF9, tracks: 80, sides: 2, sectorsPerTrack: 9, sectorsPerCluster: 2, rootEntries: 112, sectorsPerFat: 3, label: '720K DS/80T' },
  { id: 0xFA, tracks: 80, sides: 1, sectorsPerTrack: 8, sectorsPerCluster: 2, rootEntries: 112, sectorsPerFat: 1, label: '320K SS/80T' },
  { id: 0xFB, tracks: 80, sides: 2, sectorsPerTrack: 8, sectorsPerCluster: 2, rootEntries: 112, sectorsPerFat: 2, label: '640K DS/80T' },
  { id: 0xFC, tracks: 40, sides: 1, sectorsPerTrack: 9, sectorsPerCluster: 1, rootEntries: 64, sectorsPerFat: 2, label: '180K SS/40T' },
  { id: 0xFD, tracks: 40, sides: 2, sectorsPerTrack: 9, sectorsPerCluster: 2, rootEntries: 112, sectorsPerFat: 2, label: '360K DS/40T' },
  { id: 0xFE, tracks: 40, sides: 1, sectorsPerTrack: 8, sectorsPerCluster: 1, rootEntries: 64, sectorsPerFat: 1, label: '160K SS/40T' },
  { id: 0xFF, tracks: 40, sides: 2, sectorsPerTrack: 8, sectorsPerCluster: 2, rootEntries: 112, sectorsPerFat: 1, label: '320K DS/40T' },
];

/** Geometry for a media descriptor byte, or undefined for a non-MSX value. */
export function msxGeometryForId(id: number): MsxGeometry | undefined {
  return MSX_GEOMETRIES.find(g => g.id === id);
}

function bytesOf(g: MsxGeometry): number {
  return g.tracks * g.sides * g.sectorsPerTrack * MSX_SECTOR_SIZE;
}

/** The geometry to assume for an image of `length` bytes when the media
 *  descriptor does not settle it: 3.5" 80-track wins the 320K/360K ties, since
 *  that is the drive an MSX1 disk interface shipped with. */
const DEFAULT_ID_BY_SIZE = new Map<number, number>([
  [163840, 0xFE], [184320, 0xFC], [327680, 0xFA], [368640, 0xF8], [655360, 0xFB], [737280, 0xF9],
]);

/** True when `length` is a size {@link parseMsxRaw} accepts. */
export function isMsxRawSize(length: number): boolean {
  return MSX_GEOMETRIES.some(g => bytesOf(g) === length);
}

/**
 * Work out the geometry of a raw image. The FAT's own first byte (sector 1) is
 * the authority MSX-DOS uses; the BPB copy at offset 0x15 is the fallback.
 * A descriptor that agrees with the file size wins outright.
 *
 * A descriptor that describes a *bigger* disk than the file holds means a
 * truncated dump — typically the first 360K of a 720K double-sided disk, or a
 * dump cut off after the last used sector. Believing the file size would re-lay
 * the sectors out as a single-sided disk and scramble the filesystem, so the
 * descriptor's geometry is kept and the missing tail is read as unformatted
 * filler (see {@link parseMsxRaw}). A file a little *longer* than its disk
 * (some dumpers append a few spare sectors) is read as the disk and the extra
 * bytes ignored.
 *
 * Both tolerant cases insist on a 512-byte-sector BPB so that an unrelated file
 * with a stray byte in the right place is not mistaken for a disk.
 */
export function detectMsxGeometry(data: Uint8Array): MsxGeometry | null {
  const candidates = [data[MSX_SECTOR_SIZE], data[0x15]];
  for (const id of candidates) {
    const g = id === undefined ? undefined : msxGeometryForId(id);
    if (g && bytesOf(g) === data.length) return g;
  }
  if (data.length >= 2 * MSX_SECTOR_SIZE && data[0x0B] === 0x00 && data[0x0C] === 0x02) {
    for (const id of candidates) {
      const g = id === undefined ? undefined : msxGeometryForId(id);
      if (!g) continue;
      const size = bytesOf(g);
      if (data.length < size) return g;
      if (data.length - size <= MAX_TRAILING_BYTES) return g;
    }
  }
  const fallback = DEFAULT_ID_BY_SIZE.get(data.length);
  return fallback === undefined ? null : msxGeometryForId(fallback) ?? null;
}

function buildTrack(
  data: Uint8Array, base: number, cyl: number, side: number, spt: number,
): DskTrack {
  const sectors: DskSector[] = [];
  const sectorMap = new Map<number, number>();
  for (let i = 0; i < spt; i++) {
    const r = i + 1;
    const off = base + i * MSX_SECTOR_SIZE;
    sectorMap.set(r, sectors.length);
    sectors.push({
      c: cyl, h: side, r, n: 2, st1: 0, st2: 0,
      data: data.slice(off, off + MSX_SECTOR_SIZE),
    });
  }
  return { sectors, sectorMap, gap3: DEFAULT_GAP3, filler: FORMAT_FILLER };
}

function imageFromRaw(data: Uint8Array, g: MsxGeometry): DskImage {
  const trackBytes = g.sectorsPerTrack * MSX_SECTOR_SIZE;
  const tracks: (DskTrack | null)[][] = [];
  for (let c = 0; c < g.tracks; c++) {
    const sides: (DskTrack | null)[] = [];
    for (let h = 0; h < g.sides; h++) {
      sides.push(buildTrack(data, (c * g.sides + h) * trackBytes, c, h, g.sectorsPerTrack));
    }
    tracks.push(sides);
  }
  return {
    format: 'standard',
    numTracks: g.tracks,
    numSides: g.sides,
    tracks,
    diskFormat: 'MSX-DOS',
    protection: '',
  };
}

/** Parse a headerless MSX sector dump. Throws on an unrecognised size. */
export function parseMsxRaw(data: Uint8Array): DskImage {
  const g = detectMsxGeometry(data);
  if (!g) {
    if (data.length === 1474560) {
      throw new Error('1.44MB high-density disks need a 500 kbit/s controller; MSX1 disk interfaces are double density only');
    }
    throw new Error(`${data.length} bytes is not an MSX disk size (160K, 180K, 320K, 360K, 640K or 720K)`);
  }
  if (data.length < bytesOf(g)) {
    const padded = new Uint8Array(bytesOf(g)).fill(FORMAT_FILLER);
    padded.set(data);
    data = padded;
  } else if (data.length > bytesOf(g)) {
    data = data.subarray(0, bytesOf(g));
  }
  return imageFromRaw(data, g);
}

/**
 * Flatten an image back to a headerless dump. Tracks the image lacks come out
 * as formatter filler; a sector the image lacks likewise. Only meaningful for
 * regular 512-byte-sector images (see {@link isRegularMsxImage}).
 */
export function serializeMsxRaw(image: DskImage): Uint8Array {
  const spt = image.tracks[0]?.[0]?.sectors.length ?? 9;
  const trackBytes = spt * MSX_SECTOR_SIZE;
  const out = new Uint8Array(image.numTracks * image.numSides * trackBytes).fill(FORMAT_FILLER);
  for (let c = 0; c < image.numTracks; c++) {
    for (let h = 0; h < image.numSides; h++) {
      const track = image.tracks[c]?.[h];
      if (!track) continue;
      const base = (c * image.numSides + h) * trackBytes;
      for (const sec of track.sectors) {
        if (sec.r < 1 || sec.r > spt || sec.data.length < MSX_SECTOR_SIZE) continue;
        out.set(sec.data.subarray(0, MSX_SECTOR_SIZE), base + (sec.r - 1) * MSX_SECTOR_SIZE);
      }
    }
  }
  return out;
}

/**
 * True when every track of `image` holds the same count of cleanly-read
 * 512-byte sectors numbered 1..N — i.e. a headerless dump loses nothing.
 */
export function isRegularMsxImage(image: DskImage): boolean {
  const spt = image.tracks[0]?.[0]?.sectors.length ?? 0;
  if (spt === 0) return false;
  for (let c = 0; c < image.numTracks; c++) {
    for (let h = 0; h < image.numSides; h++) {
      const track = image.tracks[c]?.[h];
      if (!track || track.sectors.length !== spt) return false;
      for (let i = 0; i < spt; i++) {
        const s = track.sectors[i];
        if (s.r !== i + 1 || s.data.length !== MSX_SECTOR_SIZE || s.st1 !== 0 || s.st2 !== 0) return false;
      }
    }
  }
  return true;
}

// ── Blank disk ────────────────────────────────────────────────────────────────

/**
 * A freshly formatted, empty MSX-DOS disk: boot sector with a valid BPB, two
 * zeroed FATs carrying the media descriptor, an empty root directory and a data
 * area of formatter filler. The boot sector holds `RET NC` at offset 0x1E, which
 * is what a non-bootable MSX disk has there — the Disk BASIC ROM calls the boot
 * sector with carry clear and the stub returns straight to BASIC.
 */
export function blankMsxDisk(id: number): DskImage {
  const g = msxGeometryForId(id);
  if (!g) throw new Error(`Unknown MSX media descriptor 0x${id.toString(16)}`);
  const total = g.tracks * g.sides * g.sectorsPerTrack;
  const raw = new Uint8Array(total * MSX_SECTOR_SIZE).fill(FORMAT_FILLER);

  const reserved = 1;
  const fats = 2;
  const rootSectors = (g.rootEntries * 32) / MSX_SECTOR_SIZE;
  const systemSectors = reserved + fats * g.sectorsPerFat + rootSectors;
  raw.fill(0, 0, systemSectors * MSX_SECTOR_SIZE);

  const boot = raw.subarray(0, MSX_SECTOR_SIZE);
  boot.set([0xEB, 0xFE, 0x90]);
  boot.set(Array.from('zx84    ', ch => ch.charCodeAt(0)), 3);
  const w16 = (off: number, v: number): void => { boot[off] = v & 0xFF; boot[off + 1] = v >> 8; };
  w16(0x0B, MSX_SECTOR_SIZE);
  boot[0x0D] = g.sectorsPerCluster;
  w16(0x0E, reserved);
  boot[0x10] = fats;
  w16(0x11, g.rootEntries);
  w16(0x13, total);
  boot[0x15] = g.id;
  w16(0x16, g.sectorsPerFat);
  w16(0x18, g.sectorsPerTrack);
  w16(0x1A, g.sides);
  w16(0x1C, 0);
  boot[0x1E] = 0xD0;   // RET NC

  for (let f = 0; f < fats; f++) {
    const fat = (reserved + f * g.sectorsPerFat) * MSX_SECTOR_SIZE;
    raw.set([g.id, 0xFF, 0xFF], fat);
  }
  return imageFromRaw(raw, g);
}

// ── IMG: one header byte + raw ────────────────────────────────────────────────

/** True for a `.img` dump: a 1 (single-sided) or 2 (double-sided) byte then a
 *  raw image of the matching 360K / 720K size. */
export function isMsxImg(data: Uint8Array): boolean {
  if (data.length < 2) return false;
  const body = data.length - 1;
  return (data[0] === 1 && body === 368640) || (data[0] === 2 && body === 737280);
}

// ── DMK ───────────────────────────────────────────────────────────────────────

const DMK_HEADER = 16;
const DMK_IDAM_TABLE = 128;
const DMK_FLAG_SINGLE_SIDED = 0x10;
const DMK_FLAG_SD_ONLY = 0x40;
const DMK_FLAG_IGNORE_DENSITY = 0x80;
/** Longest the gap between an ID field and its data mark can be (MFM). */
const DMK_MAX_GAP2 = 43;

/** CRC-16/CCITT (poly 0x1021) over `bytes`, seeded for the three A1 sync bytes
 *  that precede every MFM address mark. */
function mfmCrc(bytes: ArrayLike<number>, from: number, to: number): number {
  let crc = 0xCDB4;   // CRC-CCITT of A1 A1 A1
  for (let i = from; i < to; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc;
}

/** Plausibility test for a DMK header: sane track count and length, only the
 *  documented flag bits, zeroed reserved bytes, and a length that fits. */
export function isDmk(data: Uint8Array): boolean {
  if (data.length < DMK_HEADER + DMK_IDAM_TABLE) return false;
  if (data[0] !== 0x00 && data[0] !== 0xFF) return false;
  const tracks = data[1];
  const trackLen = data[2] | (data[3] << 8);
  if (tracks < 1 || tracks > 90) return false;
  if (trackLen < DMK_IDAM_TABLE + 0x80 || trackLen > 0x2940) return false;
  if ((data[4] & ~(DMK_FLAG_SINGLE_SIDED | DMK_FLAG_SD_ONLY | DMK_FLAG_IGNORE_DENSITY)) !== 0) return false;
  for (let i = 5; i < 12; i++) if (data[i] !== 0) return false;
  const sides = (data[4] & DMK_FLAG_SINGLE_SIDED) ? 1 : 2;
  return data.length === DMK_HEADER + tracks * sides * trackLen;
}

function decodeDmkTrack(
  data: Uint8Array, base: number, trackLen: number, flags: number,
): DskTrack {
  const sectors: DskSector[] = [];
  const sectorMap = new Map<number, number>();
  const end = base + trackLen;
  for (let i = 0; i < 64; i++) {
    const entry = data[base + i * 2] | (data[base + i * 2 + 1] << 8);
    if (entry === 0) break;
    const dense = (entry & 0x8000) !== 0 || (flags & (DMK_FLAG_SD_ONLY | DMK_FLAG_IGNORE_DENSITY)) !== 0;
    // FM bytes are stored twice unless the image says they are not.
    const step = dense ? 1 : 2;
    const idam = base + (entry & 0x3FFF);
    if (idam + 7 * step > end) continue;
    const rd = (n: number): number => data[idam + n * step];
    if (rd(0) !== 0xFE) continue;
    const c = rd(1), h = rd(2), r = rd(3), nCode = rd(4);
    const idCrc = (rd(5) << 8) | rd(6);
    const idBytes = [rd(0), c, h, r, nCode];
    const idBad = idCrc !== mfmCrc(idBytes, 0, idBytes.length);

    let st1 = idBad ? 0x20 : 0;
    let st2 = 0;
    const size = 128 << (nCode & 7);
    let sectorData = new Uint8Array(size).fill(FORMAT_FILLER);

    // Locate the data mark after the ID field's CRC.
    let mark = -1;
    for (let k = 7; k < 7 + DMK_MAX_GAP2 && idam + k * step < end; k++) {
      const b = data[idam + k * step];
      if (b >= 0xF8 && b <= 0xFB) { mark = k; break; }
    }
    if (mark >= 0 && idam + (mark + 1 + size + 2) * step <= end) {
      const dataBytes: number[] = [data[idam + mark * step]];
      for (let k = 0; k < size; k++) {
        const v = data[idam + (mark + 1 + k) * step];
        dataBytes.push(v);
        sectorData[k] = v;
      }
      const crc = (data[idam + (mark + 1 + size) * step] << 8) | data[idam + (mark + 2 + size) * step];
      if (crc !== mfmCrc(dataBytes, 0, dataBytes.length)) { st1 |= 0x20; st2 |= 0x20; }
      if (dataBytes[0] !== 0xFB) st2 |= 0x40;   // deleted-data mark
    } else if (!idBad) {
      st1 |= 0x04;   // no data field found: no data
    }
    if (!sectorMap.has(r)) sectorMap.set(r, sectors.length);
    sectors.push({ c, h, r, n: nCode, st1, st2, data: sectorData });
  }
  return { sectors, sectorMap, gap3: DEFAULT_GAP3, filler: FORMAT_FILLER };
}

/** Parse a DMK dump into the shared floppy model. */
export function parseDmk(data: Uint8Array): DskImage {
  if (!isDmk(data)) throw new Error('Not a valid DMK image');
  const tracks = data[1];
  const trackLen = data[2] | (data[3] << 8);
  const flags = data[4];
  const sides = (flags & DMK_FLAG_SINGLE_SIDED) ? 1 : 2;
  const out: (DskTrack | null)[][] = [];
  for (let c = 0; c < tracks; c++) {
    const row: (DskTrack | null)[] = [];
    for (let h = 0; h < sides; h++) {
      const base = DMK_HEADER + (c * sides + h) * trackLen;
      row.push(decodeDmkTrack(data, base, trackLen, flags));
    }
    out.push(row);
  }
  return {
    format: 'standard',
    numTracks: tracks,
    numSides: sides,
    tracks: out,
    diskFormat: 'MSX-DOS',
    protection: '',
  };
}

// ── Container routing ─────────────────────────────────────────────────────────

function isCpcDsk(data: Uint8Array): boolean {
  if (data.length < 8) return false;
  const magic = String.fromCharCode(...data.subarray(0, 8));
  return magic === 'EXTENDED' || magic === 'MV - CPC';
}

/**
 * Decode any MSX disk container: bitstream / flux / Teledisk / extended-DSK
 * images by their own parsers, then DMK, `.img`, and finally a raw dump by
 * size. Throws with a readable message when nothing fits.
 */
export function parseMsxFloppy(data: Uint8Array): DskImage {
  if (isHFE(data) || isScp(data) || isTd0(data) || isCpcDsk(data)) return parseFloppyImage(data);
  if (isDmk(data)) return parseDmk(data);
  if (isMsxImg(data)) return parseMsxRaw(data.subarray(1));
  return parseMsxRaw(data);
}
