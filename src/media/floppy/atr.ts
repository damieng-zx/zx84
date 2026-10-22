/**
 * Atari 8-bit disk-image codec: ATR (with its 16-byte header) and raw XFD
 * sector dumps, exposed as a sector-addressable disk.
 *
 * ATR layout:
 *
 *   0-1    magic $0296 (little-endian)
 *   2-3    image size in 16-byte paragraphs (low 16 bits)
 *   4-5    sector size (128, 256, or up to 8192 for a hard-disk image)
 *   6-9    paragraphs high (32 bits, normally zero)
 *   10-15  flags / unused
 *   16-    sector data
 *
 * A 256-byte ATR normally stores its first three sectors as 128 bytes (the
 * 810's boot record format), so the data offset is not a simple `(n-1)*size`.
 * Some writers store all of them at 256; the tell is a data length that is a
 * whole number of 256-byte sectors, which the usual layout (384 bytes of boot
 * sectors plus 256-byte ones) can never be. Either way the drive transfers
 * 128 bytes for sectors 1-3, as the boot protocol expects. Images with larger
 * sectors (512 and up) have no boot-sector split at all.
 *
 * Raw XFD dumps have no header; their size selects the geometry. A 180K XFD
 * is stored as 720 uniform 256-byte sectors, which is not the standard ATR
 * layout, so `AtariDisk` remembers whether it is uniform and converts back to
 * the standard split when it is serialised (an ATR that was uniform on disk is
 * written back as it was).
 *
 * The SIO uses linear 1-based sector numbers; the track/sector split exists
 * only for the Drive pane and the `DskImage` view.
 */

import type { DskImage, DskTrack } from './disk-image.ts';

export const ATR_MAGIC = 0x0296;
export const ATR_HEADER_SIZE = 16;

/** Sector sizes an ATR header may declare: 128 and 256 for floppies, up to
 *  8192 for the hard-disk images SIO2PC-style servers present. */
export type AtariSectorSize = 128 | 256 | 512 | 1024 | 2048 | 4096 | 8192;

const SECTOR_SIZES: readonly number[] = [128, 256, 512, 1024, 2048, 4096, 8192];

/** Geometry choice for a raw XFD image, by byte length. */
interface XfdGeometry {
  readonly size: AtariSectorSize;
  readonly sectors: number;
  readonly sectorsPerTrack: number;
}

const XFD_GEOMETRY: Readonly<Record<number, XfdGeometry>> = {
  92_160: { size: 128, sectors: 720, sectorsPerTrack: 18 },
  133_120: { size: 128, sectors: 1040, sectorsPerTrack: 26 },
  184_320: { size: 256, sectors: 720, sectorsPerTrack: 18 },
  266_240: { size: 256, sectors: 1040, sectorsPerTrack: 26 },
  368_640: { size: 256, sectors: 1440, sectorsPerTrack: 18 },
};

export class AtariDisk {
  /** Full ATR bytes, including the 16-byte header. */
  private data: Uint8Array;
  readonly sectorSize: AtariSectorSize;
  readonly sectorCount: number;
  readonly sectorsPerTrack: number;
  /** True when a 256-byte image stores sectors 1-3 at 256 bytes too (an XFD,
   *  or an ATR written that way). */
  private readonly uniform: boolean;
  /** True when the file itself is laid out uniform, so it is saved as it was. */
  private readonly uniformFile: boolean;

  constructor(
    data: Uint8Array,
    sectorSize: AtariSectorSize,
    sectorCount: number,
    sectorsPerTrack: number,
    uniform = false,
    uniformFile = false,
  ) {
    this.data = data;
    this.sectorSize = sectorSize;
    this.sectorCount = sectorCount;
    this.sectorsPerTrack = sectorsPerTrack;
    this.uniform = uniform;
    this.uniformFile = uniformFile;
  }

  get trackCount(): number {
    return Math.ceil(this.sectorCount / this.sectorsPerTrack);
  }

  /** Bytes the drive transfers for a sector: the image's sector size, except
   *  that the first three sectors of a 256-byte disk are 128. */
  sectorLength(sector: number): number {
    return this.sectorSize === 256 && sector <= 3 ? 128 : this.sectorSize;
  }

  private offsetOf(sector: number): number {
    if (this.sectorSize !== 256 || this.uniform) {
      return ATR_HEADER_SIZE + (sector - 1) * this.sectorSize;
    }
    if (sector <= 3) return ATR_HEADER_SIZE + (sector - 1) * 128;
    return ATR_HEADER_SIZE + 3 * 128 + (sector - 4) * 256;
  }

  /** Read a 1-based sector, or null when it is outside the image. */
  readSector(sector: number): Uint8Array | null {
    if (!Number.isInteger(sector) || sector < 1 || sector > this.sectorCount) return null;
    const len = this.sectorLength(sector);
    const off = this.offsetOf(sector);
    if (off + len > this.data.length) return null;
    return this.data.slice(off, off + len);
  }

  /** Write a 1-based sector. The caller enforces write protection. */
  writeSector(sector: number, bytes: Uint8Array): boolean {
    if (!Number.isInteger(sector) || sector < 1 || sector > this.sectorCount) return false;
    const len = this.sectorLength(sector);
    const off = this.offsetOf(sector);
    if (off + len > this.data.length) return false;
    const src = bytes.subarray(0, len);
    this.data.set(src, off);
    if (src.length < len) this.data.fill(0, off + src.length, off + len);
    return true;
  }

  /** Serialise as an ATR (used by the Save button): the standard layout, or
   *  the file's own when it came in as a uniform ATR. */
  toBytes(): Uint8Array {
    if (!this.uniform || this.uniformFile) return this.data.slice();
    // Uniform 180K image -> standard ATR with 128-byte boot sectors.
    const out = new Uint8Array(ATR_HEADER_SIZE + 3 * 128 + (this.sectorCount - 3) * 256);
    out[0] = ATR_MAGIC & 0xff;
    out[1] = ATR_MAGIC >> 8;
    const paragraphs = (out.length - ATR_HEADER_SIZE) >> 4;
    out[2] = paragraphs & 0xff;
    out[3] = (paragraphs >> 8) & 0xff;
    out[4] = 0;
    out[5] = 1; // 256
    for (let s = 1; s <= 3; s++) {
      out.set(this.data.subarray(ATR_HEADER_SIZE + (s - 1) * 256,
        ATR_HEADER_SIZE + (s - 1) * 256 + 128), ATR_HEADER_SIZE + (s - 1) * 128);
    }
    out.set(this.data.subarray(ATR_HEADER_SIZE + 3 * 256), ATR_HEADER_SIZE + 3 * 128);
    return out;
  }

  /** The generic Drive-pane view: one side, linear sectors grouped into
   *  tracks of the image's own sectors-per-track. */
  toDskImage(): DskImage {
    const tracks: (DskTrack | null)[][] = [];
    for (let t = 0; t < this.trackCount; t++) {
      const sectors: DskTrack['sectors'] = [];
      const sectorMap = new Map<number, number>();
      for (let s = 0; s < this.sectorsPerTrack; s++) {
        const number = t * this.sectorsPerTrack + s + 1;
        if (number > this.sectorCount) break;
        const data = this.readSector(number);
        if (!data) continue;
        sectorMap.set(s + 1, sectors.length);
        sectors.push({
          c: t, h: 0, r: s + 1,
          n: Math.log2(data.length) - 7,
          st1: 0,
          st2: 0,
          data,
        });
      }
      tracks.push([{ sectors, sectorMap, gap3: 0, filler: 0xe5 }]);
    }
    return {
      format: 'standard',
      numTracks: this.trackCount,
      numSides: 1,
      tracks,
      diskFormat: this.sectorSize === 128
        ? (this.sectorsPerTrack === 26 ? 'Atari 1050 enhanced' : 'Atari 810')
        : 'Atari 1050 double density',
      protection: '',
    };
  }
}

/** Parse an ATR file. Returns null for a bad magic or an impossible length. */
export function parseAtr(bytes: Uint8Array): AtariDisk | null {
  if (bytes.length < ATR_HEADER_SIZE + 128) return null;
  if (bytes[0] !== (ATR_MAGIC & 0xff) || bytes[1] !== (ATR_MAGIC >> 8)) return null;
  const sectorSize = bytes[4] | (bytes[5] << 8);
  if (!SECTOR_SIZES.includes(sectorSize)) return null;
  const payload = bytes.length - ATR_HEADER_SIZE;
  // Trust the actual file length over the header's paragraph count; truncated
  // images are common in the wild, and the header count is frequently stale.
  const uniform = sectorSize === 256 && payload % 256 === 0;
  let count: number;
  if (sectorSize === 256 && !uniform) {
    const boot = Math.min(3, Math.ceil(payload / 128));
    count = boot + Math.ceil(Math.max(0, payload - 3 * 128) / 256);
  } else {
    count = Math.ceil(payload / sectorSize);
  }
  if (count < 1) return null;
  const sectorsPerTrack = count % 26 === 0 && sectorSize === 128 ? 26 : 18;
  // A last sector the file cuts short is read as zero-padded to its length.
  const full = ATR_HEADER_SIZE + (uniform || sectorSize !== 256
    ? count * sectorSize
    : Math.min(count, 3) * 128 + Math.max(0, count - 3) * 256);
  const data = new Uint8Array(Math.max(full, bytes.length));
  data.set(bytes);
  return new AtariDisk(data, sectorSize as AtariSectorSize, count, sectorsPerTrack, uniform, uniform);
}

/** Parse a raw XFD sector dump by its byte length: the usual disk sizes by
 *  name, any other whole number of 128-byte sectors as a single-density
 *  style image. */
export function parseXfd(bytes: Uint8Array): AtariDisk | null {
  let geometry = XFD_GEOMETRY[bytes.length];
  if (!geometry) {
    if (bytes.length === 0 || bytes.length % 128 !== 0) return null;
    const sectors = bytes.length / 128;
    geometry = { size: 128, sectors, sectorsPerTrack: sectors % 26 === 0 ? 26 : 18 };
  }
  const uniform = geometry.size === 256;
  if (uniform) {
    // Keep the raw sectors and synthesize a header; `AtariDisk` knows the
    // layout is uniform and converts to a standard ATR on save.
    const atr = new Uint8Array(ATR_HEADER_SIZE + bytes.length);
    atr[0] = ATR_MAGIC & 0xff;
    atr[1] = ATR_MAGIC >> 8;
    const paragraphs = bytes.length >> 4;
    atr[2] = paragraphs & 0xff;
    atr[3] = (paragraphs >> 8) & 0xff;
    atr[4] = 0;
    atr[5] = 1;
    atr.set(bytes, ATR_HEADER_SIZE);
    return new AtariDisk(atr, 256, geometry.sectors, geometry.sectorsPerTrack, true);
  }
  const atr = new Uint8Array(ATR_HEADER_SIZE + bytes.length);
  atr[0] = ATR_MAGIC & 0xff;
  atr[1] = ATR_MAGIC >> 8;
  const paragraphs = bytes.length >> 4;
  atr[2] = paragraphs & 0xff;
  atr[3] = (paragraphs >> 8) & 0xff;
  atr[4] = geometry.size;
  atr[5] = 0;
  atr.set(bytes, ATR_HEADER_SIZE);
  return new AtariDisk(atr, geometry.size, geometry.sectors, geometry.sectorsPerTrack);
}

/** Accept either container; null when neither recognises the bytes. */
export function parseAtariDisk(bytes: Uint8Array): AtariDisk | null {
  return parseAtr(bytes) ?? parseXfd(bytes);
}

/**
 * Rebuild an Atari image from the generic Drive-pane view. The shell carries
 * mounted disks across a model switch as `DskImage`s, so this is the inverse
 * of `AtariDisk.toDskImage()`.
 */
export function atrFromDskImage(image: DskImage): AtariDisk | null {
  const firstTrack = image.tracks[0]?.[0];
  if (!firstTrack || firstTrack.sectors.length === 0) return null;
  const sectorsPerTrack = firstTrack.sectors.length;
  const count = image.numTracks * sectorsPerTrack;
  if (count <= 0) return null;
  let sectorSize: AtariSectorSize = 128;
  for (const sides of image.tracks) {
    const track = sides?.[0];
    if (track && track.sectors.some(s => s.data.length === 256)) { sectorSize = 256; break; }
  }
  const payload = sectorSize === 128
    ? count * 128
    : 3 * 128 + (count - 3) * 256;
  const atr = new Uint8Array(ATR_HEADER_SIZE + payload);
  atr[0] = ATR_MAGIC & 0xff;
  atr[1] = ATR_MAGIC >> 8;
  const paragraphs = payload >> 4;
  atr[2] = paragraphs & 0xff;
  atr[3] = (paragraphs >> 8) & 0xff;
  atr[4] = sectorSize;
  atr[5] = 0;

  for (let c = 0; c < image.numTracks; c++) {
    const track = image.tracks[c]?.[0];
    if (!track) continue;
    for (const sector of track.sectors) {
      const number = c * sectorsPerTrack + sector.r;
      if (number < 1 || number > count) continue;
      const length = sectorSize === 128 || number <= 3 ? 128 : 256;
      const off = sectorSize === 128
        ? ATR_HEADER_SIZE + (number - 1) * 128
        : (number <= 3
          ? ATR_HEADER_SIZE + (number - 1) * 128
          : ATR_HEADER_SIZE + 3 * 128 + (number - 4) * 256);
      atr.set(sector.data.subarray(0, length), off);
    }
  }
  return new AtariDisk(atr, sectorSize, count, sectorsPerTrack);
}
