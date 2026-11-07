/**
 * Raw FAT12 sector images (.img) — PC-compatible disks, as EXDOS on the
 * Enterprise and MSX-DOS write them.
 *
 * The file is every sector in cylinder-major, head-minor order (C0/H0,
 * C0/H1, C1/H0, …) with no header. Geometry comes from the boot sector's BIOS
 * parameter block when it is plausible, otherwise from the file size (the
 * standard 3.5"/5.25" shapes). Sectors are 512 bytes, numbered from 1.
 */

import type { DskImage, DskSector, DskTrack } from './disk-image.ts';
import { sniffDiskContainer } from './disk-detect.ts';
import { parseFloppyImage } from './hfe.ts';
import { detectMsxGeometry, isMsxImg, parseMsxRaw } from './msx-disk.ts';

const SECTOR_BYTES = 512;

export interface FatGeometry {
  readonly tracks: number;
  readonly sides: number;
  readonly sectors: number;
}

/** Sizes of the standard formats, matched when the BPB is unusable. */
const BY_SIZE: Record<number, FatGeometry> = {
  [80 * 2 * 9 * 512]: { tracks: 80, sides: 2, sectors: 9 },     // 720K
  [80 * 2 * 18 * 512]: { tracks: 80, sides: 2, sectors: 18 },   // 1.44M
  [80 * 2 * 10 * 512]: { tracks: 80, sides: 2, sectors: 10 },   // 800K
  [40 * 2 * 9 * 512]: { tracks: 40, sides: 2, sectors: 9 },     // 360K
  [80 * 1 * 9 * 512]: { tracks: 80, sides: 1, sectors: 9 },     // 360K SS
  [40 * 1 * 9 * 512]: { tracks: 40, sides: 1, sectors: 9 },     // 180K
  [40 * 2 * 8 * 512]: { tracks: 40, sides: 2, sectors: 8 },     // 320K
  [40 * 1 * 8 * 512]: { tracks: 40, sides: 1, sectors: 8 },     // 160K
  [80 * 2 * 21 * 512]: { tracks: 80, sides: 2, sectors: 21 },   // 1.68M DMF-ish
};

/**
 * The disk's geometry: the BPB's sectors-per-track and heads when they agree
 * with the file size, else the size table. A short final track (images
 * truncated after the last used sector) is rounded up.
 */
export function fatGeometry(data: Uint8Array): FatGeometry | null {
  if (data.length >= SECTOR_BYTES && data[11] === 0x00 && data[12] === 0x02) {
    const spt = data[24] | (data[25] << 8);
    const heads = data[26] | (data[27] << 8);
    const total = data[19] | (data[20] << 8);
    if (spt >= 8 && spt <= 21 && (heads === 1 || heads === 2) && total > 0) {
      const tracks = Math.ceil(total / (spt * heads));
      if (tracks >= 35 && tracks <= 84) return { tracks, sides: heads, sectors: spt };
    }
  }
  const known = BY_SIZE[data.length];
  if (known) return known;
  return null;
}

/** Returns true if the bytes look like a raw FAT disk image. */
export function isFatImage(data: Uint8Array): boolean { return fatGeometry(data) !== null; }

/** Parse a raw FAT image into a DskImage, or null for an unrecognised shape. */
export function parseFatImage(data: Uint8Array, label = 'FAT12 IMG'): DskImage | null {
  const g = fatGeometry(data);
  if (!g) return null;
  const tracks: (DskTrack | null)[][] = [];
  for (let c = 0; c < g.tracks; c++) {
    const sides: (DskTrack | null)[] = [];
    for (let h = 0; h < g.sides; h++) {
      const base = (c * g.sides + h) * g.sectors * SECTOR_BYTES;
      const sectors: DskSector[] = [];
      const sectorMap = new Map<number, number>();
      for (let s = 0; s < g.sectors; s++) {
        const off = base + s * SECTOR_BYTES;
        const d = new Uint8Array(SECTOR_BYTES).fill(0xE5);
        if (off < data.length) d.set(data.subarray(off, Math.min(data.length, off + SECTOR_BYTES)));
        sectors.push({ c, h, r: s + 1, n: 2, st1: 0, st2: 0, data: d });
        sectorMap.set(s + 1, s);
      }
      sides.push({ sectors, sectorMap, gap3: 84, filler: 0xE5, encoding: 'mfm' });
    }
    tracks.push(sides);
  }
  return {
    format: 'standard',
    numTracks: g.tracks,
    numSides: g.sides,
    tracks,
    diskFormat: label,
    protection: '',
  };
}

/**
 * Any disk file a PC-compatible FAT machine (EXDOS) can be given: a container
 * recognised by its signature — HFE (v1/v3, FM or MFM), SCP flux, Teledisk or a
 * CPC-style (extended) DSK — decoded track by track; otherwise a headerless
 * dump, after dropping an MSX `.img` header byte, laid out by its boot sector
 * or size (see {@link fatGeometry}) or, failing that, by the MSX media
 * descriptor (truncated and padded dumps). Null when nothing fits. Disks of
 * other geometries than 720K come through intact; whether the machine's DOS
 * can read them is up to it.
 */
export function parseFatFloppy(data: Uint8Array, label = 'FAT12 IMG'): DskImage | null {
  if (sniffDiskContainer(data) !== null) return parseFloppyImage(data);
  const raw = isMsxImg(data) ? data.subarray(1) : data;
  const fat = parseFatImage(raw, label);
  if (fat) return fat;
  if (!detectMsxGeometry(raw)) return null;
  const msx = parseMsxRaw(raw);
  msx.diskFormat = label;
  return msx;
}

/** One entry of a FAT root directory. */
export interface FatDirEntry {
  /** 8.3 name as written, e.g. "GAME.COM" (no padding). */
  readonly name: string;
  readonly attributes: number;
  readonly size: number;
  /** First cluster of the file's data. */
  readonly cluster: number;
}

/** Geometry and layout a FAT12 boot sector describes, or null. */
interface FatLayout {
  sector(lba: number): Uint8Array | null;
  rootStart: number;
  rootEntries: number;
  dataStart: number;
  sectorsPerCluster: number;
}

function fatLayout(img: DskImage): FatLayout | null {
  const spt = img.tracks[0]?.[0]?.sectors.length ?? 0;
  if (spt === 0) return null;
  const sector = (lba: number): Uint8Array | null => {
    const c = Math.floor(lba / (spt * img.numSides));
    const h = Math.floor(lba / spt) % img.numSides;
    const track = img.tracks[c]?.[h];
    const idx = track?.sectorMap.get((lba % spt) + 1);
    return idx === undefined || !track ? null : track.sectors[idx].data;
  };
  const boot = sector(0);
  if (!boot || boot[11] !== 0x00 || boot[12] !== 0x02) return null;
  const sectorsPerCluster = boot[13];
  const reserved = boot[14] | (boot[15] << 8);
  const fats = boot[16];
  const rootEntries = boot[17] | (boot[18] << 8);
  const fatSectors = boot[22] | (boot[23] << 8);
  if (fats < 1 || fats > 2 || rootEntries === 0 || rootEntries > 512 || sectorsPerCluster === 0) return null;
  const rootStart = reserved + fats * fatSectors;
  return {
    sector, rootStart, rootEntries, sectorsPerCluster,
    dataStart: rootStart + Math.ceil(rootEntries * 32 / SECTOR_BYTES),
  };
}

/** The first sector of a file's data, or null when it is empty or the disk
 *  is not a readable FAT volume. */
export function fatFileFirstSector(img: DskImage, entry: FatDirEntry): Uint8Array | null {
  const fat = fatLayout(img);
  if (!fat || entry.cluster < 2 || entry.size === 0) return null;
  return fat.sector(fat.dataStart + (entry.cluster - 2) * fat.sectorsPerCluster);
}

/**
 * The root directory of a FAT12 disk, read through the boot sector's BIOS
 * parameter block. Deleted entries, volume labels and long-name fragments
 * are skipped. Empty when the boot sector does not describe a FAT volume.
 */
export function fatRootDirectory(img: DskImage): FatDirEntry[] {
  const fat = fatLayout(img);
  if (!fat) return [];
  const { sector, rootStart: first, rootEntries } = fat;
  const out: FatDirEntry[] = [];
  for (let i = 0; i < rootEntries; i++) {
    const s = sector(first + (i >> 4));
    if (!s) break;
    const at = (i & 15) * 32;
    const b0 = s[at];
    if (b0 === 0x00) break;
    if (b0 === 0xE5) continue;
    const attributes = s[at + 11];
    if (attributes & 0x08) continue;     // volume label or long-name fragment
    const text = (from: number, len: number): string =>
      String.fromCharCode(...s.subarray(at + from, at + from + len)).trimEnd();
    const base = text(0, 8);
    const ext = text(8, 3);
    out.push({
      name: ext ? `${base}.${ext}` : base,
      attributes,
      size: s[at + 28] | (s[at + 29] << 8) | (s[at + 30] << 16) | (s[at + 31] << 24),
      cluster: s[at + 26] | (s[at + 27] << 8),
    });
  }
  return out;
}

/**
 * A freshly formatted, empty FAT12 disk: boot sector with a BIOS parameter
 * block, two empty FATs and an empty root directory, the rest 0xE5 — what
 * a FORMAT leaves behind. 720K uses the standard 3.5" DD layout (2 sectors a
 * cluster, 3-sector FATs, 112 root entries, media 0xF9); 360K the 5.25" one
 * (0xFD).
 */
export function blankFatImage(tracks = 80, sides = 2, sectors = 9): DskImage {
  const total = tracks * sides * sectors;
  const data = new Uint8Array(total * SECTOR_BYTES).fill(0xE5);
  const big = total > 720;
  const media = big ? 0xF9 : 0xFD;
  const fatSectors = big ? 3 : 2;
  const rootEntries = 112;
  const spc = 2;
  const boot = data.subarray(0, SECTOR_BYTES);
  boot.fill(0);
  boot.set([0xEB, 0x3C, 0x90]);
  for (const [i, ch] of [...'EXDOS   '].entries()) boot[3 + i] = ch.charCodeAt(0);
  const put16 = (at: number, v: number): void => { boot[at] = v & 0xFF; boot[at + 1] = v >> 8; };
  put16(11, SECTOR_BYTES);
  boot[13] = spc;
  put16(14, 1);                 // reserved sectors
  boot[16] = 2;                 // FATs
  put16(17, rootEntries);
  put16(19, total);
  boot[21] = media;
  put16(22, fatSectors);
  put16(24, sectors);
  put16(26, sides);
  boot[510] = 0x55;
  boot[511] = 0xAA;
  for (let f = 0; f < 2; f++) {
    const fat = data.subarray((1 + f * fatSectors) * SECTOR_BYTES, (1 + (f + 1) * fatSectors) * SECTOR_BYTES);
    fat.fill(0);
    fat.set([media, 0xFF, 0xFF]);
  }
  const rootStart = (1 + 2 * fatSectors) * SECTOR_BYTES;
  data.fill(0, rootStart, rootStart + rootEntries * 32);
  return parseFatImage(data, 'EXDOS IMG')!;
}

/**
 * An 8.3 directory name for `name`: upper case, characters FAT does not
 * allow dropped, the base cut to eight and the extension to three. Names
 * already taken in `used` get a `~n` tail, as DOS would give them.
 */
export function fatShortName(name: string, used: Set<string>): { base: string; ext: string } {
  const clean = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9!#$%&'()\-@^_`{}~]/g, '');
  const leaf = name.replace(/^.*[\\/]/, '');
  const dot = leaf.lastIndexOf('.');
  let base = clean(dot > 0 ? leaf.slice(0, dot) : leaf).slice(0, 8) || 'FILE';
  const ext = dot > 0 ? clean(leaf.slice(dot + 1)).slice(0, 3) : '';
  for (let n = 1; used.has(`${base}.${ext}`); n++) {
    const tail = `~${n}`;
    base = base.slice(0, 8 - tail.length) + tail;
  }
  used.add(`${base}.${ext}`);
  return { base, ext };
}

/**
 * A 720K FAT12 disk holding `files` in its root directory, or null when they
 * do not fit (more than the 112 root entries, or more than the free space).
 * Names are converted with `fatShortName`; the result reports each file's
 * name on the disk.
 */
export function buildFatImage(files: readonly { name: string; data: Uint8Array }[]):
  { image: DskImage; names: string[] } | null {
  const raw = serializeFatImage(blankFatImage(80, 2, 9));
  const fatSectors = 3, rootEntries = 112, spc = 2;
  const rootStart = (1 + 2 * fatSectors) * SECTOR_BYTES;
  const dataStart = rootStart + rootEntries * 32;
  const clusterBytes = spc * SECTOR_BYTES;
  const totalClusters = Math.floor((raw.length - dataStart) / clusterBytes);
  if (files.length > rootEntries) return null;

  const fat = new Uint16Array(totalClusters + 2);
  let next = 2;
  const used = new Set<string>();
  const names: string[] = [];
  for (const [i, f] of files.entries()) {
    const clusters = Math.ceil(f.data.length / clusterBytes);
    if (next + clusters > totalClusters + 2) return null;
    const first = clusters > 0 ? next : 0;
    for (let c = 0; c < clusters; c++) {
      const cl = next + c;
      fat[cl] = c === clusters - 1 ? 0xFFF : cl + 1;
      raw.set(f.data.subarray(c * clusterBytes, (c + 1) * clusterBytes), dataStart + (cl - 2) * clusterBytes);
    }
    next += clusters;
    const { base, ext } = fatShortName(f.name, used);
    names.push(ext ? `${base}.${ext}` : base);
    const at = rootStart + i * 32;
    raw.fill(0x20, at, at + 11);
    for (let k = 0; k < base.length; k++) raw[at + k] = base.charCodeAt(k);
    for (let k = 0; k < ext.length; k++) raw[at + 8 + k] = ext.charCodeAt(k);
    raw[at + 11] = 0x20;                                  // archive
    raw[at + 26] = first & 0xFF; raw[at + 27] = first >> 8;
    for (let k = 0; k < 4; k++) raw[at + 28 + k] = (f.data.length >>> (k * 8)) & 0xFF;
  }
  // Pack the 12-bit entries into both FAT copies (media byte kept).
  for (let copy = 0; copy < 2; copy++) {
    const base = (1 + copy * fatSectors) * SECTOR_BYTES;
    for (let cl = 2; cl < fat.length; cl++) {
      const v = fat[cl];
      const off = base + Math.floor(cl * 3 / 2);
      if (cl & 1) {
        raw[off] = (raw[off] & 0x0F) | ((v << 4) & 0xF0);
        raw[off + 1] = (v >> 4) & 0xFF;
      } else {
        raw[off] = v & 0xFF;
        raw[off + 1] = (raw[off + 1] & 0xF0) | ((v >> 8) & 0x0F);
      }
    }
  }
  return { image: parseFatImage(raw, 'EXDOS IMG')!, names };
}

/** Serialize back to a flat .img. Missing sectors are written as zeros. */
export function serializeFatImage(img: DskImage): Uint8Array {
  const spt = img.tracks[0]?.[0]?.sectors.length ?? 9;
  const out = new Uint8Array(img.numTracks * img.numSides * spt * SECTOR_BYTES);
  for (let c = 0; c < img.numTracks; c++) {
    for (let h = 0; h < img.numSides; h++) {
      const track = img.tracks[c]?.[h];
      if (!track) continue;
      const base = (c * img.numSides + h) * spt * SECTOR_BYTES;
      for (let s = 0; s < spt; s++) {
        const idx = track.sectorMap.get(s + 1);
        if (idx === undefined) continue;
        out.set(track.sectors[idx].data.subarray(0, SECTOR_BYTES), base + s * SECTOR_BYTES);
      }
    }
  }
  return out;
}
